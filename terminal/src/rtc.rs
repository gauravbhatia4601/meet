// WebRTC media leg — auto-answer incoming offers, auto-offer to newcomers.
//
// Signaling handlers (sync socketio thread) forward offers/candidates/leaves
// into a channel; this module owns a dedicated thread + tokio runtime that:
//   * builds an RTCPeerConnection per peer (H264-only, recvonly video),
//   * sends answers (when offered) and offers (when we're the existing peer),
//   * relays ICE candidates both directions,
//   * depacketizes H264, decodes with openh264, and pushes decoded RGB
//     frames into the video module's peer-slot for live rendering.
//
// Outbound signals never call socket.io inline: engineio's sync client
// panics when block_on runs inside a tokio worker, so emits are queued and a
// plain dispatcher thread performs them.

use anyhow::{Context, Result};
use rust_socketio::client::Client;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::mpsc::{Receiver, TryRecvError};
use std::sync::Mutex;
use std::sync::Arc;
use std::time::Duration;

use crate::RUNNING;
use crate::video::{init_rtc_file_logger, overlay_log, set_media};

use webrtc::api::interceptor_registry::register_default_interceptors;
use webrtc::api::media_engine::{MediaEngine, MIME_TYPE_H264, MIME_TYPE_OPUS};
use webrtc::api::APIBuilder;
use webrtc::ice_transport::ice_candidate::RTCIceCandidateInit;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::sdp::sdp_type::RTCSdpType;
use webrtc::rtp_transceiver::rtp_codec::{RTCRtpCodecCapability, RTCRtpCodecParameters, RTPCodecType};
use webrtc::rtp_transceiver::rtp_transceiver_direction::RTCRtpTransceiverDirection;
use webrtc::rtp_transceiver::RTCRtpTransceiverInit;
use openh264::decoder::Decoder;
use openh264::encoder::Encoder;
use bytes::Bytes;
use openh264::formats::{RgbSliceU8, YUVBuffer, YUVSource};
use webrtc::media::Sample;
use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;
use webrtc::track::track_local::TrackLocal;
use webrtc::track::track_remote::TrackRemote;

pub type PeerHandle = Arc<webrtc::peer_connection::RTCPeerConnection>;

// Live peer socket ids + the signaling sink, for media-state broadcasts.
static PEER_IDS: Mutex<Vec<String>> = Mutex::new(Vec::new());
static SINK: Mutex<Option<OutSink>> = Mutex::new(None);
/// Inbound video ssrc → peer socket id, so the grid can label tiles.
pub fn ssrc_peer_name(ssrc: u32) -> Option<String> {
    let map = SSRC_PEER.lock().unwrap_or_else(|e| e.into_inner());
    map.iter()
        .find(|(s, _)| *s == ssrc)
        .map(|(_, n)| n.clone())
}

static SSRC_PEER: Mutex<Vec<(u32, String)>> = Mutex::new(Vec::new());

fn ssrc_peer_register(ssrc: u32, peer: &str) {
    let mut map = SSRC_PEER.lock().unwrap_or_else(|e| e.into_inner());
    if !map.iter().any(|(s, _)| *s == ssrc) {
        map.push((ssrc, peer.to_string()));
    }
}

/// Tell every peer our mic/camera state (the browser shows CAM_OFF etc).
pub fn broadcast_media_state(mic_on: bool, camera_on: bool) {
    let Some(sink) = SINK
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .map(|s| s.clone())
    else {
        return;
    };
    let ids = PEER_IDS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    for id in ids {
        sink.emit(
            "media-state",
            json!({
                "to": id,
                "state": { "micOn": mic_on, "cameraOn": camera_on, "screenShareOn": false }
            }),
        );
    }
}

/// Send a chat message to the room via the signaling relay.
pub fn send_chat(text: &str) -> bool {
    let Some(sink) = SINK
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .map(|s| s.clone())
    else {
        return false;
    };
    let room = crate::ui::room_code();
    if room.is_empty() || text.trim().is_empty() {
        return false;
    }
    sink.emit("chat-message", json!({ "roomId": room, "text": text }));
    true
}

/// Sample ICE RTT every 3s → status border (`↕ NNms`).
async fn rtt_probe(pc: PeerHandle) {
    use webrtc::stats::StatsReportType;
    loop {
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        if !RUNNING.load(Ordering::SeqCst) {
            break;
        }
        let report = pc.get_stats().await;
        let mut best = f64::MAX;
        for r in report.reports.values() {
            if let StatsReportType::CandidatePair(p) = r {
                if p.current_round_trip_time > 0.0 {
                    best = best.min(p.current_round_trip_time);
                }
            }
        }
        if best < f64::MAX {
            crate::ui::set_rtt((best * 1000.0).round() as u32);
        }
    }
}

fn register_peer(id: &str, sink: &OutSink) {
    *SINK.lock().unwrap_or_else(|e| e.into_inner()) = Some(sink.clone());
    let mut ids = PEER_IDS.lock().unwrap_or_else(|e| e.into_inner());
    if !ids.iter().any(|s| s == id) {
        ids.push(id.to_string());
    }
}

fn unregister_peer(id: &str) {
    PEER_IDS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .retain(|s| s != id);
}

/// The WebRTC thread never calls socket.io directly: engineio's sync client
/// panics when block_on runs inside a tokio worker. Signals flow out through
/// this queue and a dispatcher thread (no async context) performs the emits.
#[derive(Clone)]
pub struct OutSink {
    tx: std::sync::mpsc::Sender<(&'static str, Value)>,
}

impl OutSink {
    fn emit(&self, event: &'static str, payload: Value) {
        let _ = self.tx.send((event, payload));
    }

    /// (test support) sink + receiver, for exercising build_pc/answer_peer
    /// without a live socket.
    #[doc(hidden)]
    pub fn detached() -> (Self, std::sync::mpsc::Receiver<(&'static str, Value)>) {
        let (tx, rx) = std::sync::mpsc::channel();
        (Self { tx }, rx)
    }
}

/// Events forwarded from the socket signaling layer.
pub enum MediaEvent {
    /// Full RTCSessionDescription JSON ({"type":"offer","sdp":...})
    Offer { from: String, desc_json: String },
    /// {"type":"answer","sdp":...} — completes our own offer (newcomer replied)
    Answer { from: String, desc_json: String },
    /// RTCIceCandidateInit JSON
    Candidate { from: String, candidate_json: String },
    /// A peer joined — we (as an existing peer) must OFFER to them.
    NewPeer { socket_id: String },
    /// Remote peer disconnected from the room
    Gone { from: String },
}

const STUN_SERVERS: &[&str] = &[
    "stun:stun.l.google.com:19302",
    "stun:stun1.l.google.com:19302",
];

/// Start the media thread. `Client` is Arc-wrapped + Clone (Arc<RwLock<RawClient>>).
pub fn start(rx: Receiver<MediaEvent>, sock: Arc<Client>) {
    start_with_publish(rx, sock, true)
}

/// Whether this session publishes its camera into WebRTC (set when the user
/// asked for a camera; receive-only (--no-camera / lock-degraded) = false).
static PUBLISH: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);
/// Test hook: force publishing even without a real camera (synthetic frames).
static FORCE_PUBLISH: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Publish even without camera frames (synthetic generator feeds
/// publish_camera_frame). Used by `decode-probe --fake-cam`.
pub fn force_publish(on: bool) {
    FORCE_PUBLISH.store(on, Ordering::SeqCst);
}

pub fn start_with_publish(rx: Receiver<MediaEvent>, sock: Arc<Client>, publish: bool) {
    PUBLISH.store(publish || FORCE_PUBLISH.load(Ordering::SeqCst), Ordering::SeqCst);
    init_rtc_file_logger();
    // Outbound dispatcher: plain thread, no tokio — safe place for socket.io.
    let (otx, orx) = std::sync::mpsc::channel::<(&'static str, Value)>();
    let dispatcher = std::thread::Builder::new()
        .name("webrtc-signal-out".to_string())
        .spawn(move || {
            for (event, payload) in orx {
                if let Err(e) = sock.emit(event, payload) {
                    overlay_log(&format!("⚠️ {event} emit failed: {e}"));
                }
            }
        });
    let _ = dispatcher;

    let spawned = std::thread::Builder::new()
        .name("webrtc".to_string())
        .spawn(move || {
            let rt = match tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()
            {
                Ok(rt) => rt,
                Err(e) => {
                    overlay_log(&format!("⚠️ media runtime failed to start: {e}"));
                    return;
                }
            };
            let sink = OutSink { tx: otx };
            // Register immediately (not just at PC creation) so text features
            // like chat work even without a negotiated media peer.
            *SINK.lock().unwrap_or_else(|e| e.into_inner()) = Some(sink.clone());
            rt.block_on(async move { media_loop(rx, sink).await });
        });
    if let Err(e) = spawned {
        overlay_log(&format!("⚠️ media thread failed to spawn: {e}"));
    }
}

struct PeerBlock {
    pc: PeerHandle,
    remote_set: bool,
    buffered: Vec<RTCIceCandidateInit>,
}

async fn media_loop(rx: Receiver<MediaEvent>, out: OutSink) {
    let mut peers: HashMap<String, PeerBlock> = HashMap::new();
    let mut pending_ice: HashMap<String, Vec<RTCIceCandidateInit>> = HashMap::new();
    overlay_log("📡 webrtc peer ready — answers offers, offers to newcomers…");

    loop {
        if !RUNNING.load(Ordering::SeqCst) {
            break;
        }
        match rx.try_recv() {
            Ok(MediaEvent::Offer { from, desc_json }) => {
                overlay_log(&format!("offer from {from} — answering…"));
                match answer_peer(&out, &from, &desc_json, PUBLISH.load(Ordering::SeqCst)).await {
                    Ok(pc) => {
                        overlay_log(&format!("✅ answer sent — connecting to {from}…"));
                        tokio::spawn(rtt_probe(pc.clone()));
                        if let Some(list) = pending_ice.remove(&from) {
                            for init in list {
                                if let Err(e) = pc.add_ice_candidate(init.clone()).await {
                                    overlay_log(&format!("⚠️ buffered ICE failed: {e}"));
                                }
                            }
                        }
                        peers.insert(from, PeerBlock { pc, remote_set: true, buffered: vec![] });
                    }
                    Err(e) => overlay_log(&format!("❌ media answer failed: {e:#}")),
                }
            }
            Ok(MediaEvent::NewPeer { socket_id }) => {
                if peers.contains_key(&socket_id) {
                    continue;
                }
                overlay_log(&format!("offering to {socket_id} (recvonly, existing peer)…"));
                match offer_peer(&out, &socket_id, PUBLISH.load(Ordering::SeqCst)).await {
                    Ok(pc) => {
                        overlay_log(&format!("✅ offer sent — waiting on {socket_id}…"));
                        tokio::spawn(rtt_probe(pc.clone()));
                        if let Some(list) = pending_ice.remove(&socket_id) {
                            if !list.is_empty() {
                                pending_ice.insert(socket_id.clone(), list);
                            }
                        }
                        peers.insert(
                            socket_id.clone(),
                            PeerBlock { pc, remote_set: false, buffered: vec![] },
                        );
                    }
                    Err(e) => overlay_log(&format!("❌ offer failed: {e:#}")),
                }
            }
            Ok(MediaEvent::Answer { from, desc_json }) => {
                if let Some(block) = peers.get_mut(&from) {
                    match serde_json::from_str::<RTCSessionDescription>(&desc_json)
                        .context("bad answer JSON")
                        .and_then(|d| {
                            if !matches!(d.sdp_type, RTCSdpType::Answer) {
                                Err(anyhow::anyhow!("not an answer"))
                            } else {
                                Ok(d)
                            }
                        }) {
                        Ok(desc) => {
                            if let Err(e) = block.pc.set_remote_description(desc).await {
                                overlay_log(&format!("⚠️ set remote (answer): {e}"));
                            } else {
                                block.remote_set = true;
                                overlay_log(&format!("🔗 negotiation done with {from}"));
                                for init in block.buffered.drain(..) {
                                    if let Err(e) = block.pc.add_ice_candidate(init).await {
                                        overlay_log(&format!("⚠️ buffered ICE failed: {e}"));
                                    }
                                }
                            }
                        }
                        Err(e) => overlay_log(&format!("⚠️ bad answer: {e:#}")),
                    }
                }
            }
            Ok(MediaEvent::Candidate { from, candidate_json }) => {
                let init: RTCIceCandidateInit =
                    serde_json::from_str(&candidate_json).unwrap_or_default();
                match peers.get_mut(&from) {
                    Some(block) => {
                        if block.remote_set {
                            let pc = block.pc.clone();
                            tokio::spawn(async move {
                                if let Err(e) = pc.add_ice_candidate(init).await {
                                    overlay_log(&format!("⚠️ add_ice_candidate: {e}"));
                                }
                            });
                        } else {
                            block.buffered.push(init);
                        }
                    }
                    None => {
                        pending_ice.entry(from).or_default().push(init);
                    }
                }
            }
            Ok(MediaEvent::Gone { from }) => {
                unregister_peer(&from);
                if let Some(block) = peers.remove(&from) {
                    pending_ice.remove(&from);
                    overlay_log(&format!("closing media for {from}"));
                    let _ = block.pc.close().await;
                }
            }
            Err(TryRecvError::Empty) => tokio::time::sleep(Duration::from_millis(25)).await,
            Err(TryRecvError::Disconnected) => break,
        }
    }

    for (from, block) in peers {
        unregister_peer(&from);
        overlay_log(&format!("media teardown {from}"));
        let _ = block.pc.close().await;
    }
}

// ---------------------------------------------------------------------------
// PeerConnection construction shared by both roles (offerer & answerer).

#[allow(clippy::too_many_arguments)]
pub async fn build_pc(
    out: &OutSink,
    peer_id: &str,
    publish: bool,
) -> Result<SendHandle> {
    let mut media_engine = MediaEngine::default();
    // H264 video: browsers include packetization-mode=1 in offers, so
    // negotiation succeeds and every inbound frame is openh264-decodable.
    for codec in h264_codec_parameters() {
        media_engine
            .register_codec(codec, RTPCodecType::Video)
            .context("registering H264 codec")?;
    }
    // Opus audio: the browser's offer carries an audio m-line; the answer
    // MUST include one too (an answer with fewer m-lines than the offer is
    // invalid SDP and Chrome refuses the session — video never connects).
    // Audio itself is decoded/published in a later milestone; for now the
    // track is received and drained.
    media_engine
        .register_codec(
            RTCRtpCodecParameters {
                capability: RTCRtpCodecCapability {
                    mime_type: MIME_TYPE_OPUS.to_owned(),
                    clock_rate: 48000,
                    channels: 2,
                    sdp_fmtp_line: "minptime=10;useinbandfec=1".to_owned(),
                    rtcp_feedback: vec![],
                },
                payload_type: 111,
                stats_id: String::new(),
            },
            RTPCodecType::Audio,
        )
        .context("registering Opus codec")?;
    let registry = webrtc::interceptor::registry::Registry::new();
    let registry = register_default_interceptors(registry, &mut media_engine)
        .context("registering interceptors")?;
    let api = APIBuilder::new()
        .with_media_engine(media_engine)
        .with_interceptor_registry(registry)
        .build();

    let config = RTCConfiguration {
        ice_servers: vec![RTCIceServer {
            urls: STUN_SERVERS.iter().map(|u| u.to_string()).collect(),
            ..Default::default()
        }],
        ..Default::default()
    };
    let pc = Arc::new(
        api.new_peer_connection(config)
            .await
            .context("creating peer connection")?,
    );

    // Outgoing tracks: camera (H264) + microphone (Opus).
    let mut send: Option<Arc<TrackLocalStaticSample>> = None;
    let mut send_audio: Option<Arc<TrackLocalStaticSample>> = None;
    if publish {
        // Both tracks share ONE MediaStream id ("uplink"): the browser's
        // ontrack then always hands it the same video+audio stream. With two
        // separate stream ids the second ontrack overwrote the tile's stream
        // (audio-only) and the video never re-rendered after cam off→on.
        let track = Arc::new(TrackLocalStaticSample::new(
            h264_codec_parameters()[0].capability.clone(),
            "uplink-video".to_string(),
            "uplink".to_string(),
        ));
        crate::video::set_publishing(true);
        overlay_log("📤 publishing terminal camera (H264 sendrecv)");
        let send_track = track.clone();
        spawn_publish_pipeline(send_track, Some(pc.clone()));
        send = Some(track);

        let audio_track = Arc::new(TrackLocalStaticSample::new(
            RTCRtpCodecParameters {
                capability: RTCRtpCodecCapability {
                    mime_type: MIME_TYPE_OPUS.to_owned(),
                    clock_rate: 48_000,
                    channels: 2,
                    sdp_fmtp_line: "minptime=10;useinbandfec=1".to_owned(),
                    rtcp_feedback: vec![],
                },
                payload_type: 111,
                stats_id: String::new(),
            }
            .capability,
            "uplink-audio".to_string(),
            "uplink".to_string(),
        ));
        overlay_log("🎙 publishing terminal mic (Opus sendrecv)");
        let (atx, arx) = tokio::sync::mpsc::channel::<Vec<u8>>(32);
        let (wtx, wrx) = tokio::sync::mpsc::channel::<Vec<u8>>(32);
        crate::audio::spawn_publisher(audio_track.clone(), atx, wrx);
        tokio::spawn(async move {
            let mut arx = arx;
            // Bridge: capture→encode thread hands packets here; forward to the
            // writer half so the sample-writer task owns the track.
            while let Some(pkt) = arx.recv().await {
                if wtx.send(pkt).await.is_err() {
                    break;
                }
            }
        });
        send_audio = Some(audio_track);
    }

    // Connection-state surfacing (sticky media row).
    pc.on_peer_connection_state_change(Box::new(move |s: RTCPeerConnectionState| {
        set_media(&format!("🔗 peer: {s}"));
        Box::pin(async {})
    }));

    // Push our ICE candidates to the remote peer as they gather.
    let emit_out = out.clone();
    let emit_to = peer_id.to_string();
    let track_peer = peer_id.to_string();
    pc.on_ice_candidate(Box::new(
        move |c: Option<webrtc::ice_transport::ice_candidate::RTCIceCandidate>| {
            let emit_out = emit_out.clone();
            let emit_to = emit_to.clone();
            Box::pin(async move {
                if let Some(c) = c {
                    if let Ok(init) = c.to_json() {
                        emit_out.emit(
                            "ice-candidate",
                            json!({ "to": emit_to, "candidate": init }),
                        );
                    }
                }
            })
        },
    ));

    // Inbound video track: depacketize H264 → decode → push RGB frames.
    // NOTE: the decode loop runs in its own tokio task — a panic there
    // aborts only that task (tokio isolates it), and the panic hook in
    // install_ctrlc() writes the backtrace to /tmp/uplink-panic.log.
    pc.on_track(Box::new(
        move |track: Arc<TrackRemote>,
              _recv: Arc<webrtc::rtp_transceiver::rtp_receiver::RTCRtpReceiver>,
              _tr: Arc<webrtc::rtp_transceiver::RTCRtpTransceiver>| {
            let codec = track.codec();
            let mime = codec.capability.mime_type.to_uppercase();
            let ssrc = track.ssrc();
            ssrc_peer_register(ssrc, &track_peer);
            overlay_log(&format!(
                "🎥 remote track ssrc={ssrc} codec={mime} — decoding…"
            ));
            if mime.contains("H264") {
                tokio::spawn(decode_task(track.clone(), mime, ssrc));
            } else if mime.contains("OPUS") {
                // Inbound audio: decode → speakers (mic/speaker loopback echo
                // caveat: use headphones, or mute the mic).
                overlay_log(&format!(
                    "🔊 remote audio track ssrc={ssrc} — playing"
                ));
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 4096];
                    loop {
                        match track.read(&mut buf).await {
                            Ok((pkt, _)) => {
                                crate::audio::decode_and_play(&pkt.payload);
                            }
                            Err(_) => break,
                        }
                    }
                    overlay_log(&format!(
                        "🔊 remote audio track ssrc={ssrc} ended"
                    ));
                });
            } else {
                // Unknown codec — drain so the buffer can't grow.
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 4096];
                    loop {
                        if track.read(&mut buf).await.is_err() {
                            break;
                        }
                    }
                });
            }
            Box::pin(async {})
        },
    ));

    Ok(SendHandle {
        pc,
        track: send,
        audio: send_audio,
    })
}

/// The per-track decode loop: depacketize → openh264 → YUV→RGB → peer slot.
async fn decode_task(track: Arc<TrackRemote>, mime: String, ssrc: u32) {
    if !mime.contains("H264") {
        set_media("⚠️ browser sent a non-H264 codec — decode skipped");
        return;
    }
    let mut dep = crate::h264::H264Depacketizer::new();
    let mut dec = match Decoder::new() {
        Ok(d) => d,
        Err(e) => {
            set_media(&format!("⚠️ openh264 init failed: {e}"));
            return;
        }
    };
    let mut packets: u64 = 0;
    let mut frames: u64 = 0;
    let mut bytes: u64 = 0;
    let mut buf = vec![0u8; 65536];
    let mut last_stat = std::time::Instant::now();
    loop {
        match track.read(&mut buf).await {
            Ok((pkt, _attrs)) => {
                packets += 1;
                bytes += pkt.payload.len() as u64;
                if packets == 1 {
                    overlay_log("🎬 peer RTP arriving — assembling H264…");
                }
                if let Some(au) = dep.feed(&pkt.payload) {
                    match dec.decode(&au) {
                        Ok(Some(yuv)) => {
                            let (w, h) = yuv.dimensions();
                            let mut rgb = vec![0u8; w * h * 3];
                            yuv.write_rgb8(&mut rgb);
                            frames += 1;
                            if frames == 1 {
                                overlay_log(&format!(
                                    "🎬 FIRST peer frame decoded ({w}x{h}) — live video!"
                                ));
                                set_media(&format!("🎥 peer video: {w}x{h} DECODING"));
                            }
                            crate::video::push_peer_frame(crate::video::PeerFrame {
                                ssrc: ssrc as u64,
                                w: w as u32,
                                h: h as u32,
                                rgb: Arc::new(rgb),
                                at: std::time::Instant::now(),
                            });
                        }
                        _ => {}
                    }
                }
                if last_stat.elapsed() >= Duration::from_secs(1) {
                    last_stat = std::time::Instant::now();
                    if frames > 0 {
                        set_media(&format!(
                            "🎥 peer video: {frames} decoded @ {packets} pkts — LIVE"
                        ));
                    } else {
                        set_media(&format!(
                            "🎥 peer video: {packets} pkts / 0 decoded — waiting for H264 frames…"
                        ));
                    }
                }
            }
            Err(_) => break,
        }
    }
    overlay_log(&format!(
        "🎥 remote track ssrc={ssrc} ended after {packets} pkts / {frames} frames"
    ));
}

/// Everything a media role needs after negotiation wiring.
pub struct SendHandle {
    pub pc: Arc<webrtc::peer_connection::RTCPeerConnection>,
    /// Some = we publish our camera on this track.
    pub track: Option<Arc<TrackLocalStaticSample>>,
    /// Some = we publish our mic on this track.
    pub audio: Option<Arc<TrackLocalStaticSample>>,
}

/// Incoming offer (browser is offerer): set remote, answer.
pub async fn answer_peer(
    out: &OutSink,
    from: &str,
    desc_json: &str,
    publish: bool,
) -> Result<PeerHandle> {
    let offer: RTCSessionDescription = serde_json::from_str(desc_json)
        .context("offer JSON was not an RTCSessionDescription")?;
    if !matches!(offer.sdp_type, RTCSdpType::Offer) {
        anyhow::bail!("description type was not 'offer'");
    }

    let handle = build_pc(out, from, publish).await?;
    let pc = handle.pc;
    register_peer(from, out);

    // Attach our camera BEFORE set_remote_description: the transceiver we
    // pre-create (sendrecv, carrying our track) is then matched with the
    // browser's video m-line, so ONE m-line carries both directions.
    // (replace_track on a remote-created sender fails: it has no track
    // envelope yet — "new track must have the same envelope as previous".)
    if let Some(track) = &handle.track {
        pc.add_transceiver_from_track(
            track.clone() as Arc<dyn TrackLocal + Send + Sync>,
            Some(RTCRtpTransceiverInit {
                direction: RTCRtpTransceiverDirection::Sendrecv,
                send_encodings: vec![],
            }),
        )
        .await
        .context("pre-attaching camera transceiver for answer")?;
    }
    if let Some(audio) = &handle.audio {
        pc.add_transceiver_from_track(
            audio.clone() as Arc<dyn TrackLocal + Send + Sync>,
            Some(RTCRtpTransceiverInit {
                direction: RTCRtpTransceiverDirection::Sendrecv,
                send_encodings: vec![],
            }),
        )
        .await
        .context("pre-attaching mic transceiver for answer")?;
    }

    pc.set_remote_description(offer)
        .await
        .context("set remote (offer)")?;

    if !publish {
        pc.add_transceiver_from_kind(
            RTPCodecType::Video,
            Some(RTCRtpTransceiverInit {
                direction: RTCRtpTransceiverDirection::Recvonly,
                send_encodings: vec![],
            }),
        )
        .await
        .context("adding recvonly video transceiver")?;
    }

    let answer = pc.create_answer(None).await.context("create answer")?;
    let answer_value = serde_json::to_value(&answer).context("marshal answer")?;
    pc.set_local_description(answer).await.context("set local (answer)")?;
    out.emit("answer", json!({ "to": from, "answer": answer_value }));
    if let Some(local) = pc.local_description().await {
        overlay_log(&format!(
            "📨 answer sent to {from} ({} bytes sdp)",
            local.sdp.len()
        ));
        // SDP dump for flow debugging (UPLINK_DUMP_SDP=/path)
        if let Ok(path) = std::env::var("UPLINK_DUMP_SDP") {
            let _ = std::fs::write(&path, &local.sdp);
        }
    }

    Ok(pc)
}

/// We joined first: create the offer ourselves for the newcomer.
pub async fn offer_peer(out: &OutSink, peer_id: &str, publish: bool) -> Result<PeerHandle> {
    let handle = build_pc(out, peer_id, publish).await?;
    let pc = handle.pc;
    register_peer(peer_id, out);

    // Sendrecv when the camera publishes (one m-line carries both ways).
    let direction = if publish {
        RTCRtpTransceiverDirection::Sendrecv
    } else {
        RTCRtpTransceiverDirection::Recvonly
    };

    if let Some(track) = &handle.track {
        pc.add_transceiver_from_track(
            track.clone() as Arc<dyn TrackLocal + Send + Sync>,
            Some(RTCRtpTransceiverInit {
                direction,
                send_encodings: vec![],
            }),
        )
        .await
        .context("adding sendrecv video transceiver + camera track")?;
    } else {
        pc.add_transceiver_from_kind(
            RTPCodecType::Video,
            Some(RTCRtpTransceiverInit {
                direction: RTCRtpTransceiverDirection::Recvonly,
                send_encodings: vec![],
            }),
        )
        .await
        .context("adding recvonly video transceiver")?;
    }
    if let Some(audio) = &handle.audio {
        pc.add_transceiver_from_track(
            audio.clone() as Arc<dyn TrackLocal + Send + Sync>,
            Some(RTCRtpTransceiverInit {
                direction,
                send_encodings: vec![],
            }),
        )
        .await
        .context("adding audio transceiver + mic track")?;
    }

    let offer = pc.create_offer(None).await.context("create offer")?;
    let offer_value = serde_json::to_value(&offer).context("marshal offer")?;
    pc.set_local_description(offer).await.context("set local (offer)")?;
    out.emit("offer", json!({ "to": peer_id, "offer": offer_value }));
    if let Some(local) = pc.local_description().await {
        overlay_log(&format!(
            "📤 offer sent to {peer_id} ({} bytes sdp)",
            local.sdp.len()
        ));
    }

    Ok(pc)
}

/// H264 codec params (knob: registering ONLY these makes the browser
/// negotiate H264, which openh264 can decode).
/// Publish cadence: forced intra frames let peers resync/late-join.
/// (Chrome cannot decode mid-GOP and the first openh264 frame is the only
/// default IDR; without forcing, late joins never decode.)
const IDR_PERIOD: u64 = 48; // ~2s @ 25fps

/// Publish pipeline: camera frame → downscale → YUV → openh264 → RTP.
fn spawn_publish_pipeline(
    track: Arc<TrackLocalStaticSample>,
    pc: Option<Arc<webrtc::peer_connection::RTCPeerConnection>>,
) {
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Vec<u8>>(8);

    // Encoder thread (no awaits → the pointerful openh264 bitstream never
    // crosses an await point).
    let _encoder = std::thread::Builder::new()
        .name("cam-encode".into())
        .spawn(move || {
            let mut enc = match Encoder::new() {
                Ok(e) => e,
                Err(e) => {
                    crate::video::set_publishing(false);
                    set_media(&format!("⚠️ openh264 encoder init failed: {e}"));
                    return;
                }
            };
            let mut last_seq: u64 = 0;
            let mut encoded_frames: u64 = 0;
            let mut sps_pps: Vec<u8> = Vec::new();
            let mut last_encode_at = std::time::Instant::now();
            loop {
                std::thread::sleep(Duration::from_millis(20));
                let Some(f) = crate::video::latest_camera_frame() else {
                    continue;
                };
                if f.seq == last_seq {
                    continue;
                }
                // Resume after a pause (cam toggle): force a keyframe so the
                // remote decoder can resync — mid-GOP deltas render nothing.
                if last_encode_at.elapsed() > Duration::from_millis(600) {
                    enc.force_intra_frame();
                }
                last_encode_at = std::time::Instant::now();
                last_seq = f.seq;

                // Encode at ≤640 wide (even dims) — smooth 25fps on the M2.
                let (ew, eh) = publish_dims(f.w as usize, f.h as usize);
                let mut small = vec![0u8; ew * eh * 3];
                crate::video::downscale_box_into(
                    f.rgb.as_slice(),
                    f.w as usize,
                    0,
                    0,
                    f.w as usize,
                    f.h as usize,
                    ew,
                    eh,
                    false, // browsers mirror client-side if desired
                    &mut small,
                );
                let yuv = YUVBuffer::from_rgb8_source(RgbSliceU8::new(&small, (ew, eh)));
                if encoded_frames % IDR_PERIOD == 0 {
                    enc.force_intra_frame(); // keeps joiners/resyncs decodable
                }
                let bs = match enc.encode(&yuv) {
                    Ok(b) => b,
                    Err(e) => {
                        set_media(&format!("⚠️ encode error: {e}"));
                        continue;
                    }
                };
                let mut bits = Vec::with_capacity(64 * 1024);
                bs.write_vec(&mut bits);

                // Remember SPS/PPS from the first frame; re-attach to every
                // forced IDR so receivers can always start decoding.
                if let Some(pps) = extract_sps_pps(&bits) {
                    sps_pps = pps;
                } else if encoded_frames % IDR_PERIOD == 1 && !sps_pps.is_empty() && !bits.is_empty() {
                    // The frame right after a forced IDR — but openh264 only
                    // emits SPS/PPS in the very first frame; re-inject them.
                    let starts_with_sps = bits.len() > 4
                        && bits[0] == 0
                        && bits[1] == 0
                        && bits[2] == 1
                        && (bits[3] & 0x1f == 7);
                    if !starts_with_sps {
                        let mut prefixed = Vec::with_capacity(sps_pps.len() + bits.len());
                        prefixed.extend_from_slice(&sps_pps);
                        prefixed.extend_from_slice(&bits);
                        bits = prefixed;
                    }
                }

                encoded_frames += 1;
                if encoded_frames == 1 {
                    overlay_log(&format!("📤 first camera frame published ({ew}x{eh} H264)"));
                    set_media("📤 camera publishing → peer");
                }
                // packet_timestamp: 90kHz; writer stamps its own duration.
                if tx.blocking_send(bits).is_err() {
                    return; // writer closed
                }
            }
        });

    // Async writer: annex-B frames → RTP. Held back until Connected so the
    // FIRST keyframe actually reaches the peer (pre-DTLS packets die).
    tokio::spawn(async move {
        if let Some(pc) = &pc {
            while pc.connection_state() != RTCPeerConnectionState::Connected {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }
        let mut frame_i: u32 = 0;
        while let Some(bits) = rx.recv().await {
            if bits.is_empty() {
                continue;
            }
            frame_i = frame_i.wrapping_add(1);
            let sample = Sample {
                data: Bytes::from(bits),
                timestamp: std::time::SystemTime::now(),
                duration: Duration::from_millis(40),
                packet_timestamp: frame_i.wrapping_mul(3600), // 40ms @ 90kHz
                prev_dropped_packets: 0,
                prev_padding_packets: 0,
            };
            let _ = track.write_sample(&sample).await;
        }
    });
}

/// Encode dimensions: width ≤ 640, even width/height, never upscale.
fn publish_dims(w: usize, h: usize) -> (usize, usize) {
    let cw = w.min(640) & !1;
    let ch = ((h as u64 * w.min(640) as u64 / w as u64) as usize).max(2) & !1;
    (cw.max(2), ch.max(2))
}

/// Pull the SPS (type 7) + PPS (type 8) NAL units (with start codes) from an
/// annex-B bitstream; returns None unless BOTH are present.
fn extract_sps_pps(bits: &[u8]) -> Option<Vec<u8>> {
    fn find_units(bits: &[u8]) -> Vec<(usize, usize)> {
        let mut out = vec![];
        let mut i = 0;
        while i + 3 <= bits.len() {
            if bits[i] == 0 && bits[i + 1] == 0 && bits[i + 2] == 1 {
                                let mut j = i + 3;
                while j + 2 < bits.len() {
                    if bits[j] == 0 && bits[j + 1] == 0 && (bits[j + 2] == 1 || (bits[j + 2] == 0 && bits.get(j + 3) == Some(&1))) {
                        break;
                    }
                    j += 1;
                }
                out.push((i + 3, j));
                i = j;
            } else {
                i += 1;
            }
        }
        out
    }
    let mut sps = None;
    let mut pps = None;
    for (s, e) in find_units(bits) {
        if bits[s] & 0x1f == 7 {
            sps.replace(bits[s - 3..e].to_vec());
        } else if bits[s] & 0x1f == 8 {
            pps.replace(bits[s - 3..e].to_vec());
        }
    }
    match (sps, pps) {
        (Some(a), Some(b)) => {
            let mut out = a;
            out.extend_from_slice(&b);
            Some(out)
        }
        _ => None,
    }
}

pub fn h264_codec_parameters() -> Vec<RTCRtpCodecParameters> {
    vec![
        h264("level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f", 102u8),
        h264("level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42001f", 127u8),
    ]
}

#[allow(dead_code)]
fn h264(fmtp_in: &str, pt: u8) -> RTCRtpCodecParameters {
    RTCRtpCodecParameters {
        capability: RTCRtpCodecCapability {
            mime_type: MIME_TYPE_H264.to_owned(),
            clock_rate: 90000,
            channels: 0,
            sdp_fmtp_line: fmtp_in.to_owned(),
            rtcp_feedback: vec![],
        },
        payload_type: pt,
        stats_id: String::new(),
    }
}