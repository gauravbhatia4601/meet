// Signaling client (Phase 2) — socket.io client for the meeting server.
//
// Flow per session: connect → (create+join | join) → signaling events stream
// live (pinned to the overlay once the camera runs), while offers/candidates/
// leaves are ALSO forwarded into the WebRTC media thread (rtc::start) to be
// answered. Auto-reconnects fire Event::Connect again, which re-joins the same
// room — the created room id is remembered per session so `new` rejoins rather
// than recreating.
//
// Server protocol (mirrors server/src/index.ts + client/src/types.ts):
//   client → server:  create-room (ack {ok, roomId})
//                     join-room {roomId, displayName} (ack {ok, error?})
//                     offer/answer/ice-candidate {to, …}
//   server → client:  participants, new-peer, peer-disconnected,
//                     offer/answer/ice-candidate {from, …}, chat-message,
//                     media-state, raise-hand

use anyhow::{Context, Result};
use rust_socketio::{ClientBuilder, Event, Payload, RawClient, TransportType};
use serde_json::{json, Value};
use std::sync::atomic::Ordering;
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::rtc::{self, MediaEvent};
use crate::RUNNING;
use crate::video::{self, overlay_log, VideoOpts};

type AckSlot = Arc<Mutex<Option<Result<(), String>>>>;

fn payload_json(p: &Payload) -> Option<Value> {
    let mut val = match p {
        // socket.io acks arrive double-wrapped: Text([[{...}]])
        Payload::Text(vals) => vals.first().cloned()?,
        Payload::String(s) => serde_json::from_str(s).ok()?,
        Payload::Binary(b) => json!({"_binary_bytes": b.len()}),
    };
    while let Some(arr) = val.as_array() {
        val = arr.first().cloned()?;
    }
    Some(val)
}

fn sdp_len(v: &Value) -> usize {
    v["offer"]["sdp"]
        .as_str()
        .or_else(|| v["answer"]["sdp"].as_str())
        .map(|s| s.len())
        .unwrap_or(0)
}

fn join_ack_outcome(ack_payload: &Payload) -> Result<(), String> {
    match payload_json(ack_payload) {
        Some(v) if v["ok"].as_bool() == Some(true) => Ok(()),
        Some(v) => Err(format!(
            "join refused: {}",
            v["error"].as_str().unwrap_or("(unknown error)")
        )),
        None => Err("[join-room] unparseable ack".to_string()),
    }
}

/// Both sync client flavors (RawClient from handlers, Client post-connect)
/// can emit joins.
trait CanEmitJoin {
    fn emit_with_ack_join(&self, params: Value, slot: AckSlot) -> anyhow::Result<()>;
}

impl CanEmitJoin for RawClient {
    fn emit_with_ack_join(&self, params: Value, slot: AckSlot) -> anyhow::Result<()> {
        self.emit_with_ack(
            "join-room",
            params,
            Duration::from_secs(5),
            move |ack_payload: Payload, _sock: RawClient| {
                *slot.lock().unwrap() = Some(join_ack_outcome(&ack_payload));
            },
        )
        .map_err(anyhow::Error::from)
    }
}

impl CanEmitJoin for rust_socketio::client::Client {
    fn emit_with_ack_join(&self, params: Value, slot: AckSlot) -> Result<()> {
        self.emit_with_ack(
            "join-room",
            params,
            Duration::from_secs(5),
            move |ack_payload: Payload, _sock: RawClient| {
                *slot.lock().unwrap() = Some(join_ack_outcome(&ack_payload));
            },
        )
        .map_err(anyhow::Error::from)
    }
}

fn emit_join<T: AsRef<str>>(
    sock: &impl CanEmitJoin,
    room_id: T,
    name: &str,
    result_slot: AckSlot,
) {
    overlay_log(&format!("requesting join of room: {}", room_id.as_ref()));
    if let Err(e) = sock.emit_with_ack_join(
        json!({"roomId": room_id.as_ref(), "displayName": name}),
        result_slot,
    ) {
        overlay_log(&format!("⚠️ join-room emit failed: {e}"));
    }
}

fn wait_created(slot: &Arc<Mutex<Option<String>>>) -> Result<String> {
    loop {
        if !RUNNING.load(Ordering::SeqCst) {
            anyhow::bail!("aborted while creating the room");
        }
        if let Some(r) = slot.lock().unwrap().clone() {
            return Ok(r);
        }
        std::thread::sleep(Duration::from_millis(40));
    }
}

/// Engine.io's first request is plain HTTP: a `ws(s)://` scheme makes newer
/// reqwest bail with "URL scheme is not allowed". Normalize before building.
fn http_url(server: &str) -> String {
    server
        .replacen("ws://", "http://", 1)
        .replacen("wss://", "https://", 1)
}

fn wait_ack(slot: &AckSlot) -> Result<()> {
    loop {
        if !RUNNING.load(Ordering::SeqCst) {
            anyhow::bail!("aborted");
        }
        if let Some(res) = slot.lock().unwrap().clone() {
            return res.map_err(|e| anyhow::anyhow!("{e}"));
        }
        std::thread::sleep(Duration::from_millis(40));
    }
}

/// Drop into the render loop (blocking until Ctrl+C) when configured.
/// Camera contention (another tab/app holding FaceTime HD) must not kill the
/// call — the session degrades to receive-only.
fn start_video(video_cfg: Option<VideoOpts>) -> Result<()> {
    match video_cfg {
        Some(opts) => {
            eprintln!("🎥 camera starting — Ctrl+C to leave the call");
            if let Err(e) = video::webcam_render(opts) {
                overlay_log(&format!(
                    "⚠️ local video unavailable ({e}) — staying in the room as receive-only"
                ));
                spin_until_exit()
            } else {
                Ok(())
            }
        }
        None => spin_until_exit(),
    }
}

fn spin_until_exit() -> Result<()> {
    // Receive-only / probe sessions still get the full TUI: input thread +
    // deck, painted on a timer (there's no render loop to do it per frame).
    let _ = crossterm::terminal::enable_raw_mode();
    crate::ui::enter_ui();
    crate::ui::start_input_thread();
    print!("\x1b[2J\x1b[H");
    use std::io::Write as _;
    let _ = std::io::stdout().flush();
    while RUNNING.load(Ordering::SeqCst) {
        crate::video::process_actions();
        crate::ui::paint_deck();
        std::thread::sleep(Duration::from_millis(150));
    }
    crate::ui::exit_ui();
    let _ = crossterm::terminal::disable_raw_mode();
    Ok(())
}

/// Attach all signaling handlers: overlay UI + forwarding into the WebRTC
/// media thread.
fn log_events(builder: ClientBuilder, media_tx: Sender<MediaEvent>) -> ClientBuilder {
    let tx_offer = media_tx.clone();
    let tx_ice = media_tx.clone();
    let tx_gone = media_tx.clone();
    let tx_answer = media_tx.clone();
    let tx_newpeer = media_tx.clone();
    builder
        .on("participants", |payload: Payload, _sock: RawClient| {
            if let Some(v) = payload_json(&payload) {
                let entries: Vec<(String, String)> = v["participants"]
                    .as_array()
                    .map(|list| {
                        list.iter()
                            .filter_map(|p| {
                                let id = p["socketId"].as_str()?.to_string();
                                let name = p["displayName"].as_str()?.to_string();
                                Some((id, name))
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                let names: Vec<String> =
                    entries.iter().map(|(_, n)| n.clone()).collect();
                crate::ui::set_roster(entries);
                crate::ui::set_participants(names);
            }
        })
                .on("chat-message", move |payload: Payload, _sock: RawClient| {
            if let Some(v) = payload_json(&payload) {
                let name = v["senderName"].as_str().unwrap_or("peer").to_string();
                let text = v["text"].as_str().unwrap_or("").to_string();
                if text.is_empty() {
                    return;
                }
                // The relay echoes our own sends back — render the echo as
                // the single copy (no local push on send).
                let mine = name == crate::ui::my_name();
                crate::ui::push_chat(&name, &text, mine);
                if !mine {
                    crate::ui::push_event(&format!("💬 {name}: {text}"));
                }
            }
        })
.on("new-peer", move |payload: Payload, _sock: RawClient| {
            let media_tx = tx_newpeer.clone();
            if let Some(v) = payload_json(&payload) {
                overlay_log(&format!(
                    "👋 peer joined: {} — offering (sendrecv, camera on) to them now",
                    v["peerSocketId"].as_str().unwrap_or("?")
                ));
                if let Some(id) = v["peerSocketId"].as_str().map(|s| s.to_string()) {
                    let _ = media_tx.send(MediaEvent::NewPeer { socket_id: id });
                }
            }
        })
        .on("offer", move |payload: Payload, _sock: RawClient| {
            let media_tx = tx_offer.clone();
            if let Some(v) = payload_json(&payload) {
                let from = v["from"].as_str().unwrap_or("?").to_string();
                overlay_log(&format!(
                    "📩 offer from {} ({} bytes sdp) — answering…",
                    v["from"].as_str().unwrap_or("?"),
                    sdp_len(&v)
                ));
                if let Ok(desc) = serde_json::to_string(&v["offer"]) {
                    let _ = media_tx.send(MediaEvent::Offer { from, desc_json: desc });
                }
            }
        })
        .on("answer", move |payload: Payload, _sock: RawClient| {
            let media_tx = tx_answer.clone();
            if let Some(v) = payload_json(&payload) {
                overlay_log(&format!(
                    "📨 answer from {} ({} bytes sdp)",
                    v["from"].as_str().unwrap_or("?"),
                    sdp_len(&v)
                ));
                if let Some(from) = v["from"].as_str().map(|s| s.to_string()) {
                    if let Ok(desc) = serde_json::to_string(&v["answer"]) {
                        let _ = media_tx.send(MediaEvent::Answer { from, desc_json: desc });
                    }
                }
            }
        })
        .on("ice-candidate", move |payload: Payload, _sock: RawClient| {
            // Silent: candidates arrive in bursts (up to ~30/s) — they power
            // ICE, not the UI. The file trail (/tmp/uplink-overlay.log) still
            // captures them for debugging.
            let media_tx = tx_ice.clone();
            if let Some(v) = payload_json(&payload) {
                let from = v["from"].as_str().unwrap_or("?").to_string();
                if let Ok(cand) = serde_json::to_string(&v["candidate"]) {
                    let _ = media_tx.send(MediaEvent::Candidate { from, candidate_json: cand });
                }
            }
        })
        .on("peer-disconnected", move |payload: Payload, _sock: RawClient| {
            let media_tx = tx_gone.clone();
            if let Some(v) = payload_json(&payload) {
                let from = v["socketId"].as_str().unwrap_or("?").to_string();
                overlay_log(&format!("🚪 peer left: {from}"));
                let _ = media_tx.send(MediaEvent::Gone { from });
            }
        })
        .on("media-state", |payload: Payload, _sock: RawClient| {
            if let Some(v) = payload_json(&payload) {
                overlay_log(&format!(
                    "🎛  media-state {}: {}",
                    v["from"].as_str().unwrap_or("?"),
                    v["state"]
                ));
            }
        })
        .on("raise-hand", |payload: Payload, _sock: RawClient| {
            if let Some(v) = payload_json(&payload) {
                overlay_log(&format!(
                    "✋ {} raised a hand",
                    v["from"].as_str().unwrap_or("?")
                ));
            }
        })
        .on(Event::Close, |_payload: Payload, _sock: RawClient| {
            overlay_log("🔌 connection closed — reconnecting if the server returns…");
        })
        .on(Event::Error, |payload: Payload, _sock: RawClient| {
            overlay_log(&format!(
                "[socket warning] {payload:?} — transport reconnecting…"
            ));
        })
}

fn connect(
    server: &str,
    media_tx: Sender<MediaEvent>,
) -> Result<rust_socketio::client::Client> {
    let socket = log_events(
        ClientBuilder::new(&http_url(server)).transport_type(TransportType::WebsocketUpgrade),
        media_tx,
    )
    .connect()
    .context("socket.io connect failed")?;
    Ok(socket)
}


/// `new` — create a room, then join it. Prints the shareable code.
/// The room id is remembered so auto-reconnects REJOIN instead of creating.
pub fn create_and_join(server: &str, name: &str, video_cfg: Option<VideoOpts>) -> Result<()> {
    let (media_tx, media_rx) = std::sync::mpsc::channel::<MediaEvent>();
    let join_name = name.to_string();
    let created_room: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let created_for_reconnect = created_room.clone();
    let name_for_reconnect = join_name.clone();

    println!("🔌 connecting to {server} …");

    let builder = ClientBuilder::new(&http_url(server))
        .transport_type(TransportType::WebsocketUpgrade)
        .on(Event::Connect, move |_payload: Payload, sock: RawClient| {
            let created_room = created_for_reconnect.clone();
            let name = name_for_reconnect.clone();
            let already = created_room.lock().unwrap().clone();
            match already {
                Some(room_id) => {
                    overlay_log(&format!("🔁 reconnected — rejoining room {room_id}"));
                    emit_join(&sock, room_id, &name, Arc::new(Mutex::new(None)));
                }
                None => {
                    overlay_log("✅ connected — creating room");
                    let ack_room = created_room.clone();
                    // create-room takes NO data args: the ack callback must be
                    // the only server-side argument, hence the empty payload.
                    if let Err(e) = sock.emit_with_ack(
                        "create-room",
                        Payload::Text(vec![]),
                        Duration::from_secs(5),
                        move |ack_payload: Payload, _sock: RawClient| {
                            if let Some(v) = payload_json(&ack_payload) {
                                if let Some(r) = v["roomId"].as_str().map(|s| s.to_string()) {
                                    crate::ui::set_room_code(&r);
                                    crate::ui::push_event(&format!("🎫 room {r} — share the code"));
                                    *ack_room.lock().unwrap() = Some(r);
                                } else {
                                    overlay_log(&format!("❌ room creation failed: {v}"));
                                    RUNNING.store(false, Ordering::SeqCst);
                                }
                            }
                        },
                    ) {
                        overlay_log(&format!("[create-room] emit failed: {e}"));
                        RUNNING.store(false, Ordering::SeqCst);
                    }
                }
            }
        });

    let socket = log_events(builder, media_tx)
        .connect()
        .context("socket.io connect failed")?;
    rtc::start_with_publish(media_rx, Arc::new(socket.clone()), video_cfg.is_some());

    let room_id = wait_created(&created_room)?;

    // First join happens here (main thread). Reconnects rejoin via Connect.
    let joined: AckSlot = Arc::new(Mutex::new(None));
    emit_join(&socket, &room_id, name, joined.clone());
    wait_ack(&joined)?;
    overlay_log("   roster + signaling follow");
    start_video(video_cfg)?;

    let _ = socket.disconnect();
    println!("👋 left the meeting");
    Ok(())
}

/// `join <code>` — join an existing room by code.
pub fn join_room(server: &str, code: &str, name: &str, video_cfg: Option<VideoOpts>) -> Result<()> {
    println!("🔌 connecting to {server} …");

    let room_id = code.trim().to_lowercase();
    let join_name = name.to_string();
    let my_room = room_id.clone();

    let (media_tx, media_rx) = std::sync::mpsc::channel::<MediaEvent>();
    let first_slot: AckSlot = Arc::new(Mutex::new(None));
    let slot_in_handler = first_slot.clone();

    let builder = ClientBuilder::new(&http_url(server))
        .transport_type(TransportType::WebsocketUpgrade)
        .on(Event::Connect, move |_payload: Payload, sock: RawClient| {
            // Fires on the first connect AND on every auto-reconnect. The
            // first join ack lands in `first_slot`; reconnects reuse the room.
            let already = slot_in_handler.lock().unwrap().clone();
            match already {
                Some(_) => emit_join(&sock, &my_room, &join_name, Arc::new(Mutex::new(None))),
                None => emit_join(&sock, &my_room, &join_name, slot_in_handler.clone()),
            }
        });

    let socket = log_events(builder, media_tx)
        .connect()
        .context("socket.io connect failed")?;
    rtc::start_with_publish(media_rx, Arc::new(socket.clone()), video_cfg.is_some());

    wait_ack(&first_slot)?;
    crate::ui::set_my_name(name);
    crate::ui::set_room_code(&room_id);
    crate::ui::push_event(&format!("🎫 joined room {room_id} as {name}"));
    overlay_log("   roster + signaling follow");
    start_video(video_cfg)?;

    let _ = socket.disconnect();
    println!("👋 left the meeting");
    Ok(())
}
