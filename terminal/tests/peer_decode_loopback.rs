//! End-to-end peer-video decode loopback — no browser, no camera.
//!
//! Side A ("fake browser"): a real webrtc-rs PeerConnection with an
//! H264 TrackLocalStaticSample — what a Chrome tab effectively does.
//! Side B: the PRODUCTION pipeline — answer_peer()/build_pc() straight from
//! src/rtc.rs, including the real on_track depacketize→decode→push task.
//!
//! A offers → B answers → connect → A pumps openh264-encoded alternating
//! color frames → assert decoded RGB tiles land in the shared peer-frame
//! slot with correct dimensions and surviving color content.
//!
//! Run: cargo test --test peer_decode_loopback -- --nocapture

use bytes::Bytes;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

use openh264::encoder::Encoder;
use openh264::formats::YUVBuffer;
use uplink_terminal::rtc::{answer_peer, h264_codec_parameters, OutSink};
use uplink_terminal::video::latest_peer_frame;

const W: usize = 320;
const H: usize = 240;

/// Raw I420 Vec of a solid color (BT.601), Y+W*H then U then V.
fn raw_i420(color: (u8, u8, u8)) -> Vec<u8> {
    let (r, g, b) = (color.0 as f32, color.1 as f32, color.2 as f32);
    let y = (0.299 * r + 0.587 * g + 0.114 * b) as u8;
    let u = (128.0 - 0.169 * r - 0.331 * g + 0.5 * b) as u8;
    let v = (128.0 + 0.5 * r - 0.419 * g - 0.081 * b) as u8;
    let (luma, chroma) = (W * H, W * H / 4);
    let mut buf = vec![0u8; luma + 2 * chroma];
    buf[..luma].fill(y);
    buf[luma..luma + chroma].fill(u);
    buf[luma + chroma..].fill(v);
    buf
}

/// Dominant channel of the frame centre (16x32 region): 0 green, 1 red,
/// 2 blue, 3 other/dark.
fn rgb_dominance(rgb: &[u8]) -> u8 {
    let mut r = 0u64;
    let mut g = 0u64;
    let mut b = 0u64;
    let mut n = 0u64;
    for y in (H / 2 - 8)..(H / 2 + 8) {
        for x in (W / 2 - 8)..(W / 2 + 8) {
            let off = (y * W + x) * 3;
            if off + 3 <= rgb.len() {
                r += rgb[off] as u64;
                g += rgb[off + 1] as u64;
                b += rgb[off + 2] as u64;
                n += 1;
            }
        }
    }
    if n == 0 {
        return 3;
    }
    let (r, g, b) = (r / n, g / n, b / n);
    let m = r.max(g).max(b);
    if m <= 60 {
        3
    } else if m == g {
        0
    } else if m == r {
        1
    } else {
        2
    }
}

use webrtc::api::interceptor_registry::register_default_interceptors;
use webrtc::api::media_engine::MediaEngine;
use webrtc::api::APIBuilder;
use webrtc::ice_transport::ice_candidate::{RTCIceCandidate, RTCIceCandidateInit};
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::media::Sample;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
use webrtc::peer_connection::sdp::sdp_type::RTCSdpType;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::rtp_transceiver::rtp_codec::RTPCodecType;
use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;

fn make_sample(bits: Vec<u8>, i: u32) -> Sample {
    Sample {
        data: Bytes::from(bits),
        timestamp: SystemTime::now(),
        duration: Duration::from_millis(33),
        packet_timestamp: i.wrapping_mul(3000),
        prev_dropped_packets: 0,
        prev_padding_packets: 0,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn browser_offer_to_terminal_decodes_h264() {
    // ── fake browser PC (same H264-only engine as production) ───────────
    let fake = {
        let mut me = MediaEngine::default();
        for codec in h264_codec_parameters() {
            me.register_codec(codec, webrtc::rtp_transceiver::rtp_codec::RTPCodecType::Video)
                .expect("register H264");
        }
        let registry = register_default_interceptors(
            webrtc::interceptor::registry::Registry::new(),
            &mut me,
        )
        .expect("interceptors");
        let api = APIBuilder::new()
            .with_media_engine(me)
            .with_interceptor_registry(registry)
            .build();
        let config = RTCConfiguration {
            ice_servers: vec![RTCIceServer {
                urls: vec!["stun:stun.l.google.com:19302".to_string()],
                ..Default::default()
            }],
            ..Default::default()
        };
        Arc::new(api.new_peer_connection(config).await.expect("fake pc"))
    };

    // Relay fake's ICE candidates → the production answerer.
    let (fake_cand_tx, fake_cand_rx) = std::sync::mpsc::channel::<RTCIceCandidateInit>();
    fake.on_ice_candidate(Box::new(
        move |c: Option<RTCIceCandidate>| {
            if let Some(c) = c {
                if let Ok(init) = c.to_json() {
                    let _ = fake_cand_tx.send(init);
                }
            }
            Box::pin(async {})
        },
    ));

    // ── sendonly H264 track (a browser camera's video) ──────────────────
    let video_track = Arc::new(TrackLocalStaticSample::new(
        h264_codec_parameters()[0].capability.clone(),
        "video".to_string(),
        "fake-browser".to_string(),
    ));
    fake.add_track(video_track.clone()).await.unwrap();

    // ── offer → PRODUCTION answer_peer ─────────────────────────────────
    let (out, rx) = OutSink::detached();
    let offer = fake.create_offer(None).await.unwrap();
    fake.set_local_description(offer).await.unwrap();
    let local = fake.local_description().await.unwrap();
    assert_eq!(local.sdp_type, RTCSdpType::Offer);
    let offer_json = serde_json::to_string(&local).unwrap();

    let pc_answer = answer_peer(&out, "fake-browser", &offer_json, false)
        .await
        .expect("answer_peer failed");

    // ── take the answer (+ early candidates) from the sink ─────────────
    let mut answer: Option<RTCSessionDescription> = None;
    let mut answerer_cands: Vec<RTCIceCandidateInit> = Vec::new();
    let answer_deadline = Instant::now() + Duration::from_secs(6);
    while answer.is_none() {
        assert!(Instant::now() < answer_deadline, "no answer within 6s");
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(("answer", v)) => {
                let a = v.get("answer").expect("answer payload").clone();
                answer = Some(serde_json::from_value::<RTCSessionDescription>(a).unwrap());
            }
            Ok(("ice-candidate", v)) => {
                let c: RTCIceCandidate =
                    serde_json::from_value(v.get("candidate").unwrap().clone()).unwrap();
                answerer_cands.push(c.to_json().unwrap());
            }
            Ok(_) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(e) => panic!("sink rx closed: {e}"),
        }
    }
    let answer = answer.unwrap();
    assert_eq!(answer.sdp_type, RTCSdpType::Answer);
    let sdp_l = answer.sdp.to_lowercase();
    assert!(sdp_l.contains("h264"), "answer SDP lacks H264:\n{}", answer.sdp);
    println!("✅ answer negotiated with H264");

    fake.set_remote_description(answer).await.unwrap();
    for c in std::mem::take(&mut answerer_cands) {
        fake.add_ice_candidate(c).await.unwrap();
    }

    // ── wait for Connected on both sides, relaying candidates ──────────
    let deadline = Instant::now() + Duration::from_secs(12);
    loop {
        loop {
            match rx.try_recv() {
                Ok(("ice-candidate", v)) => {
                    let init: RTCIceCandidateInit =
                        serde_json::from_value(v.get("candidate").unwrap().clone()).unwrap();
                    let _ = fake.add_ice_candidate(init).await;
                }
                Ok(_) => {}
                Err(std::sync::mpsc::TryRecvError::Empty) => break,
                Err(e) => panic!("sink closed: {e}"),
            }
        }
        loop {
            match fake_cand_rx.try_recv() {
                Ok(init) => {
                    let _ = pc_answer.add_ice_candidate(init).await;
                }
                Err(std::sync::mpsc::TryRecvError::Empty) => break,
                Err(_) => break,
            }
        }
        if pc_answer.connection_state() == RTCPeerConnectionState::Connected
            && fake.connection_state() == RTCPeerConnectionState::Connected
        {
            break;
        }
        let astate = pc_answer.connection_state();
        assert!(
            Instant::now() < deadline && astate != RTCPeerConnectionState::Failed,
            "not connected in 12s (answerer {astate:?})"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    println!("✅ peer connections Connected");

    // ── pump openh264-encoded color frames → watch the shared slot ─────
    let mut enc = Encoder::new().expect("openh264 encoder");
    let colors = [(0u8, 255u8, 0u8), (200, 0, 0), (0, 0, 255)];
    let mut frames_seen = 0u32;
    let mut green = 0u32;
    let mut red = 0u32;
    let mut blue = 0u32;
    let start = Instant::now();

    for i in 0..220u32 {
        let color = colors[(i as usize) % colors.len()];
        let bs = enc.encode(&YUVBuffer::from_vec(raw_i420(color), W, H))
            .expect("encode");
        let mut bits = Vec::with_capacity(32 * 1024);
        bs.write_vec(&mut bits);
        let sample = Sample {
            data: Bytes::from(bits),
            timestamp: SystemTime::now(),
            duration: Duration::from_millis(33),
            packet_timestamp: i.wrapping_mul(3000),
            prev_dropped_packets: 0,
            prev_padding_packets: 0,
        };
        video_track.write_sample(&sample).await.unwrap();
        tokio::time::sleep(Duration::from_millis(24)).await;
        if let Some(rgb) = latest_peer_frame() {
            assert_eq!(
                rgb.len(),
                W * H * 3,
                "decoded frame dims mismatch: {} bytes (want {})",
                rgb.len(),
                W * H * 3
            );
            frames_seen += 1;
            match rgb_dominance(&rgb) {
                0 => green += 1,
                1 => red += 1,
                2 => blue += 1,
                _ => {}
            }
        }
    }
    println!(
        "📊 frames decoded: {frames_seen} in {:.1?} — green={green} red={red} blue={blue}",
        start.elapsed()
    );

    assert!(
        frames_seen >= 100,
        "decode pipeline produced only {frames_seen} frames in {:.1?}",
        start.elapsed()
    );
    assert!(
        green >= 5 && red >= 2 && blue >= 2,
        "color did not survive: green={green} red={red} blue={blue}"
    );
    println!("✅ loopback OK: offer→answer→ICE/DTLS→H264 RTP→depacketize→openh264→RGB→peer slot");
}