//! Audio: mic capture → Opus encode (publish), inbound Opus → speakers.
//!
//! All conversion uses incremental linear resamplers that keep their phase
//! across callback boundaries (a stateless per-batch convert produced
//! constant/garbled output — the "noise" bug).

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

pub const SAMPLE_RATE: u32 = 48_000;
pub const FRAME_SAMPLES: usize = 960; // 20 ms mono @ 48 kHz

static MIC_ON: AtomicBool = AtomicBool::new(true);

pub fn mic_on() -> bool {
    MIC_ON.load(Ordering::SeqCst)
}
pub fn set_mic_on(on: bool) {
    MIC_ON.store(on, Ordering::SeqCst);
}

/// 48 kHz mono i16 samples ready for the encoder.
static MIC_PCM: Mutex<VecDeque<i16>> = Mutex::new(VecDeque::new());
/// 48 kHz mono i16 decoded samples ready for the speakers.
static SPK_PCM: Mutex<VecDeque<i16>> = Mutex::new(VecDeque::new());

const MIC_BACKLOG_MAX: usize = SAMPLE_RATE as usize; // 1 s ceiling
const SPK_BACKLOG_MAX: usize = SAMPLE_RATE as usize * 4;

fn mic_pcm() -> std::sync::MutexGuard<'static, VecDeque<i16>> {
    MIC_PCM.lock().unwrap_or_else(|e| e.into_inner())
}

// ── Resamplers ──────────────────────────────────────────────────────────

/// Incremental converter: device-rate input frames → 48 kHz mono i16.
struct CapState {
    /// Fractional position (in input-sample steps) toward the next output.
    phase: f64,
    /// Previous input sample (interpolation anchor across callbacks).
    prev: f32,
    primed: bool,
}

static CAP_STATE: Mutex<CapState> = Mutex::new(CapState {
    phase: 0.0,
    prev: 0.0,
    primed: false,
});

impl CapState {
    /// Convert one callback of device-rate input (mono mixdown inside)
    /// into 48 kHz mono i16.
    fn convert(
        &mut self,
        input: &[f32],
        device_rate: u32,
        channels: usize,
        q: &mut VecDeque<i16>,
    ) {
        let step = device_rate as f64 / SAMPLE_RATE as f64; // input steps per output
        let ch = channels.max(1);
        for frame in input.chunks(ch) {
            let s = if frame.len() == ch {
                frame.iter().sum::<f32>() / ch as f32
            } else {
                frame[0]
            };
            while self.phase < 1.0 {
                let v = self.prev + (s - self.prev) * self.phase as f32;
                q.push_back((v.clamp(-1.0, 1.0) * 32767.0) as i16);
                self.phase += step;
            }
            self.phase -= 1.0;
            self.prev = s;
        }
        while q.len() > MIC_BACKLOG_MAX {
            q.pop_front();
        }
    }
}

/// Incremental converter: 48 kHz mono queue → device-rate output frames.
struct PlayState {
    /// Fractional position (in 48 kHz steps) between `last` and next.
    frac: f64,
    last: i16,
}

static PLAY_STATE: Mutex<PlayState> = Mutex::new(PlayState { frac: 0.0, last: 0 });

impl PlayState {
    /// Fill one output frame (all channels get the same mono sample).
    fn render(&mut self, q: &mut VecDeque<i16>, frame: &mut [f32], device_rate: u32) {
        self.frac += SAMPLE_RATE as f64 / device_rate as f64; // 48k steps per output sample
        while self.frac >= 1.0 {
            self.last = q.pop_front().unwrap_or(self.last);
            self.frac -= 1.0;
        }
        let next = q.front().copied().unwrap_or(self.last);
        let v = self.last as f32 + (next as f32 - self.last as f32) * self.frac as f32;
        for slot in frame.iter_mut() {
            *slot = v / 32768.0;
        }
    }
}

// ── Capture (mic) ───────────────────────────────────────────────────────

/// Start the mic capture stream (idempotent). Triggers the macOS mic
/// permission prompt on first use.
pub fn ensure_capture() -> Result<(), String> {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    static STARTED: AtomicBool = AtomicBool::new(false);
    if STARTED.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    let host = cpal::default_host();
    let Some(device) = host.default_input_device() else {
        return Err("no microphone found".into());
    };
    let config = device
        .default_input_config()
        .map_err(|e| format!("mic config failed: {e}"))?;
    let rate = config.sample_rate().0;
    let channels = config.channels() as usize;
    overlay(&format!(
        "🎙 capture: {} Hz × {} ch ({})",
        rate, channels, config.sample_format()
    ));

    let err_fn = move |err: cpal::StreamError| eprintln!("  [mic] error: {err}");
    let stream = match config.sample_format() {
        cpal::SampleFormat::F32 => device.build_input_stream(
            &config.into(),
            move |data: &[f32], _| {
                let mut state = CAP_STATE.lock().unwrap_or_else(|e| e.into_inner());
                if !state.primed {
                    state.prev = data.first().copied().unwrap_or(0.0);
                    state.primed = true;
                }
                let mut q = mic_pcm();
                state.convert(data, rate, channels, &mut q);
            },
            err_fn,
            None,
        ),
        cpal::SampleFormat::I16 => device.build_input_stream(
            &config.into(),
            move |data: &[i16], _| {
                let mut state = CAP_STATE.lock().unwrap_or_else(|e| e.into_inner());
                let f: Vec<f32> = data.iter().map(|&s| s as f32 / 32768.0).collect();
                if !state.primed {
                    state.prev = f.first().copied().unwrap_or(0.0);
                    state.primed = true;
                }
                let mut q = mic_pcm();
                state.convert(&f, rate, channels, &mut q);
            },
            |err| eprintln!("  [mic] capture error: {err}"),
            None,
        ),
        other => return Err(format!("unsupported mic sample format: {other}")),
    }
    .map_err(|e| format!("mic stream failed: {e}"))?;
    stream
        .play()
        .map_err(|e| format!("mic start failed: {e}"))?;
    std::mem::forget(stream); // keep alive for the process lifetime
    Ok(())
}

fn take_frame() -> Option<Vec<i16>> {
    let mut q = mic_pcm();
    if q.len() < FRAME_SAMPLES {
        return None;
    }
    Some(q.drain(..FRAME_SAMPLES).collect())
}

// ── Playback (inbound → speakers) ───────────────────────────────────────

/// Start the speaker output stream once (idempotent).
pub fn ensure_playback() -> Result<(), String> {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    static STARTED: AtomicBool = AtomicBool::new(false);
    if STARTED.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    let host = cpal::default_host();
    let Some(device) = host.default_output_device() else {
        return Err("no speaker found".into());
    };
    let config = device
        .default_output_config()
        .map_err(|e| format!("speaker config failed: {e}"))?;
    let rate = config.sample_rate().0;
    let channels = config.channels() as usize;
    overlay(&format!(
        "🔊 playback: {} Hz × {} ch ({})",
        rate, channels, config.sample_format()
    ));

    let err_fn = move |err: cpal::StreamError| eprintln!("  [speaker] error: {err}");
    let stream = match config.sample_format() {
        cpal::SampleFormat::F32 => device.build_output_stream(
            &config.into(),
            move |out: &mut [f32], _| {
                let mut q = SPK_PCM.lock().unwrap_or_else(|e| e.into_inner());
                let mut state = PLAY_STATE.lock().unwrap_or_else(|e| e.into_inner());
                for frame in out.chunks_mut(channels) {
                    state.render(&mut q, frame, rate);
                }
            },
            err_fn,
            None,
        )
        .map_err(|e| format!("speaker stream failed: {e}"))?,
        cpal::SampleFormat::I16 => device.build_output_stream(
            &config.into(),
            move |out: &mut [i16], _| {
                let mut q = SPK_PCM.lock().unwrap_or_else(|e| e.into_inner());
                let mut state = PLAY_STATE.lock().unwrap_or_else(|e| e.into_inner());
                let mut f32buf = vec![0f32; out.len()];
                for (fi, frame) in f32buf.chunks_mut(channels).enumerate() {
                    let src = &mut out[fi * channels..(fi + 1) * channels];
                    state.render(&mut q, frame, rate);
                    for (si, slot) in src.iter_mut().enumerate() {
                        *slot = frame[si] as i16;
                    }
                }
            },
            err_fn,
            None,
        )
        .map_err(|e| format!("speaker stream failed: {e}"))?,
        other => return Err(format!("unsupported speaker sample format: {other}")),
    };
    stream
        .play()
        .map_err(|e| format!("speaker start failed: {e}"))?;
    std::mem::forget(stream);
    Ok(())
}

pub fn push_playback(samples: &[i16]) {
    let mut q = SPK_PCM.lock().unwrap_or_else(|e| e.into_inner());
    for &s in samples {
        q.push_back(s);
    }
    while q.len() > SPK_BACKLOG_MAX {
        q.pop_front();
    }
}

// ── Publisher: capture → Opus → RTP samples ─────────────────────────────

/// Per-publisher Opus encode loop: capture → 20 ms frames → writer channel.
pub fn spawn_publisher(
    track: Arc<webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample>,
    tx: tokio::sync::mpsc::Sender<Vec<u8>>,
    rx: tokio::sync::mpsc::Receiver<Vec<u8>>,
) {
    let _t = std::thread::Builder::new().name("mic-encode".into()).spawn(move || {
        if let Err(e) = ensure_capture() {
            overlay(&format!("🎙 mic unavailable: {e}"));
            return;
        }
        let mut enc = match opus::Encoder::new(
            SAMPLE_RATE,
            opus::Channels::Mono,
            opus::Application::Voip,
        ) {
            Ok(e) => e,
            Err(e) => {
                overlay(&format!("🎙 opus encoder failed: {e}"));
                return;
            }
        };
        overlay("🎙 mic encoder running (48 kHz mono, 20 ms frames)");
        let mut pkt = vec![0u8; 512];
        loop {
            std::thread::sleep(std::time::Duration::from_millis(10));
            if !mic_on() {
                take_frame(); // drain so un-mute doesn't replay history
                continue;
            }
            let Some(frame) = take_frame() else {
                continue;
            };
            match enc.encode(&frame, &mut pkt) {
                Ok(n) if n > 0 => {
                    if tx.blocking_send(pkt[..n].to_vec()).is_err() {
                        return;
                    }
                }
                _ => {}
            }
        }
    });

    tokio::spawn(async move {
        let mut rx = rx;
        let mut ts = 0u32;
        while let Some(pkt) = rx.recv().await {
            ts = ts.wrapping_add(960); // 20 ms @ 48 kHz
            let sample = webrtc::media::Sample {
                data: bytes::Bytes::from(pkt),
                timestamp: std::time::SystemTime::now(),
                duration: std::time::Duration::from_millis(20),
                packet_timestamp: ts,
                prev_dropped_packets: 0,
                prev_padding_packets: 0,
            };
            let _ = track.write_sample(&sample).await;
        }
    });
}

/// Inbound Opus packet → decode → playback queue.
pub fn decode_and_play(payload: &[u8]) {
    static DECODER: OnceLock<Mutex<opus::Decoder>> = OnceLock::new();
    let dec = DECODER.get_or_init(|| {
        let _ = ensure_playback();
        Mutex::new(opus::Decoder::new(SAMPLE_RATE, opus::Channels::Mono).expect("opus decoder"))
    });
    let mut out = vec![0i16; SAMPLE_RATE as usize / 25]; // 40 ms ceiling
    match dec
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .decode(payload, &mut out, false)
    {
        Ok(n) if n > 0 => {
            let mut q = SPK_PCM.lock().unwrap_or_else(|e| e.into_inner());
            for &s in &out[..n] {
                q.push_back(s);
            }
            while q.len() > SPK_BACKLOG_MAX {
                q.pop_front();
            }
        }
        _ => {}
    }
}

fn overlay(msg: &str) {
    crate::video::overlay_log(msg);
}