// Video pipeline — camera capture, geometry, renderers, and the frame loop.
// Shared by three entry points: standalone video (`uplink-terminal --size …`),
// `join`, and `new` — signaling sessions all fall into the same webcam_render
// loop once the room is established.

use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine as _;
use nokhwa::pixel_format::RgbFormat;
use nokhwa::utils::{
    CameraFormat, CameraIndex, FrameFormat, RequestedFormat, RequestedFormatType, Resolution,
};
use nokhwa::Camera;

use crate::kitty::KittyEnc;
use crate::render::{render_ansi, render_quadrant};
use crate::sixel::SixelEnc;

use crate::RUNNING;

/// Single log rule for the whole app: messages are ALWAYS painted at the
/// last terminal row, absolutely positioned. Plain eprintln would inherit the
/// cursor's mid-row column (video loop + multiple threads) and produce the
/// staircase/jumped look. No newline is ever emitted -> zero scrolling.
/// Transient messages: painted on the line above the status bar.
/// Rolling event history: latest 3 messages pinned above the deck, so a
/// rapid burst (offer/answer/Connected/track) stays readable.
/// Minimal file logger for the webrtc stack (webrtc-rs uses the `log`
/// facade). Default level: warn — set UPLINK_WEBRTC_DEBUG=1 for the full
/// negotiation trace at /tmp/uplink-webrtc.log.
pub fn init_rtc_file_logger() {
    use log::{LevelFilter, Log, Metadata, Record};
    struct FileLogger(std::fs::File, LevelFilter);
    impl Log for FileLogger {
        fn enabled(&self, meta: &Metadata) -> bool {
            meta.level() <= self.1
        }
        fn log(&self, record: &Record) {
            use std::io::Write;
            let mut f = &self.0;
            let _ = writeln!(
                f,
                "{} [{:<5}] {}: {}",
                chrono_like_now(),
                record.level(),
                record.target(),
                record.args()
            );
            let _ = f.flush();
        }
        fn flush(&self) {}
    }
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let debug = std::env::var("UPLINK_WEBRTC_DEBUG").as_deref() == Ok("1");
        let level = if debug { LevelFilter::Trace } else { LevelFilter::Warn };
        let file = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open("/tmp/uplink-webrtc.log")
            .expect("log file");
        let logger = FileLogger(file, level);
        log::set_boxed_logger(Box::new(logger)).ok();
        log::set_max_level(level);
    });
}

/// Millisecond timestamp for file logs (no chrono dependency).
fn chrono_like_now() -> String {
    let d = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_else(|_| std::time::Duration::ZERO);
    format!("{}.{:03}", d.as_secs(), d.subsec_millis())
}

pub fn overlay_log(msg: &str) {
    use std::io::Write;
    // File trail survives crashes/pipes — the single source of truth for
    // post-mortems (stdout is best-effort UI only).
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open("/tmp/uplink-overlay.log")
    {
        let _ = writeln!(f, "{} {}", chrono_like_now(), msg.replace('\n', " "));
    }
    crate::ui::push_event(msg);
}

/// Persistent line: WebRTC media state (peer connected / RTP counters).
pub fn set_media(msg: &str) {
    crate::ui::set_media(msg);
}

/// One camera frame offered to the webrtc publish path (encoded there).
#[derive(Clone)]
pub struct PublishFrame {
    pub w: u32,
    pub h: u32,
    pub rgb: Arc<Vec<u8>>,
    pub seq: u64,
}

static LOCAL_FRAME: std::sync::Mutex<Option<PublishFrame>> = std::sync::Mutex::new(None);
static LOCAL_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
/// How many webrtc peers we are currently publishing to (gates the per-frame copy).
static PUBLISHERS: AtomicBool = AtomicBool::new(false);

pub fn publishers_active() -> bool {
    PUBLISHERS.load(Ordering::SeqCst)
}

pub fn set_publishing(on: bool) {
    PUBLISHERS.store(on, Ordering::SeqCst);
}

/// webcam_render calls this every captured frame (only while a WebRTC peer
/// exists, to keep the copy cost at zero for camera-only renders).
pub fn publish_camera_frame(w: u32, h: u32, rgb: Arc<Vec<u8>>) {
    let seq = LOCAL_SEQ.fetch_add(1, Ordering::SeqCst) + 1;
    *LOCAL_FRAME.lock().unwrap_or_else(|e| e.into_inner()) = Some(PublishFrame { w, h, rgb, seq });
}

/// Latest camera frame for the encoder (Arc — no copy on read).
pub fn latest_camera_frame() -> Option<PublishFrame> {
    LOCAL_FRAME.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

/// Inbound peer video frame decoded on the webrtc thread.
#[derive(Clone)]
pub struct PeerFrame {
    pub ssrc: u64,
    pub w: u32,
    pub h: u32,
    pub rgb: Arc<Vec<u8>>,
    pub at: Instant,
}

/// Active peer frames, one slot per ssrc (up to 4 grid tiles).
static PEER_FRAMES: std::sync::Mutex<Vec<PeerFrame>> = std::sync::Mutex::new(Vec::new());
/// Total decoded inbound frames since process start (for self-tests).
pub static PEER_FRAMES_TOTAL: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

pub fn push_peer_frame(f: PeerFrame) {
    let mut frames = PEER_FRAMES.lock().unwrap_or_else(|e| e.into_inner());
    match frames.iter_mut().find(|p| p.ssrc == f.ssrc) {
        Some(slot) => *slot = f,
        None => {
            if frames.len() < 4 {
                frames.push(f);
            }
        }
    }
    PEER_FRAMES_TOTAL.fetch_add(1, Ordering::SeqCst);
}

/// Fresh (< 1.5s) peer frames, newest first, up to 4.
fn fresh_peer_frames() -> Vec<PeerFrame> {
    let mut frames = PEER_FRAMES.lock().unwrap_or_else(|e| e.into_inner());
    frames.retain(|f| f.at.elapsed() < Duration::from_millis(1500));
    let mut v = frames.clone();
    v.sort_by(|a, b| b.at.cmp(&a.at));
    v.truncate(4);
    v
}

/// Latest decoded peer frame if fresh (< 1.5s old).
pub fn latest_peer_frame() -> Option<Arc<Vec<u8>>> {
    fresh_peer_frames().first().map(|f| f.rgb.clone())
}

#[derive(Clone)]
pub struct PeerInfo {
    pub w: u32,
    pub h: u32,
    pub rgb: Arc<Vec<u8>>,
}

/// Same as `latest_peer_frame()` but also returns the frame's dimensions,
/// atomically consistent with the buffer (one lock acquisition).
pub fn latest_peer_info() -> Option<PeerInfo> {
    fresh_peer_frames().first().map(|f| PeerInfo {
        w: f.w,
        h: f.h,
        rgb: Arc::clone(&f.rgb),
    })
}

pub fn peer_present() -> bool {
    !fresh_peer_frames().is_empty()
}

pub fn parse_size(s: &str) -> (u32, u32) {
    let parts: Vec<&str> = s.split('x').collect();
    let w = parts.first().and_then(|p| p.parse().ok()).unwrap_or(640);
    let h = parts.get(1).and_then(|p| p.parse().ok()).unwrap_or(480);
    (w, h)
}

// ── JPEG encoder (for iTerm2 frames) ────────────────────────────────────────
struct JpegSink<'a> {
    buf: &'a mut Vec<u8>,
}
impl Write for JpegSink<'_> {
    fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        self.buf.extend_from_slice(data);
        Ok(data.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn encode_jpeg_into(rgb: &[u8], w: usize, h: usize, quality: u8, out: &mut Vec<u8>) {
    out.clear();
    let mut sink = JpegSink { buf: out };
    let enc = jpeg_encoder::Encoder::new(&mut sink, quality);
    let _ = enc.encode(rgb, w as u16, h as u16, jpeg_encoder::ColorType::Rgb);
}

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

/// Terminal pixel size via TIOCGWINSZ (iTerm2 reports these).
fn window_pixel_size() -> (usize, usize) {
    let mut ws = libc::winsize {
        ws_row: 0,
        ws_col: 0,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    let ok = unsafe { libc::ioctl(libc::STDOUT_FILENO, libc::TIOCGWINSZ, &mut ws) };
    if ok == 0 && ws.ws_xpixel > 0 && ws.ws_ypixel > 0 {
        (ws.ws_xpixel as usize, ws.ws_ypixel as usize)
    } else {
        (0, 0)
    }
}

/// Probe kitty graphics support: transmit a real 1×1 image + read the placement
/// ACK. Returns (usable, saw_real_ack) — the version-string fallback path may
/// mark kitty usable without ever having seen an ACK (recorded in the second
/// value so diagnostics can tell the two cases apart).
/// When `keep_raw` is true and probing succeeds, raw mode is left ENABLED so
/// the video loop can read ACKs (and Ctrl+C bytes) — caller must disable it.
fn probe_kitty_support(keep_raw: bool) -> (bool, bool) {
    use std::io::Write;
    if crossterm::terminal::enable_raw_mode().is_err() {
        return (false, false);
    }
    // 1x1 black pixel, raw 24-bit (uncompressed): 3 zero bytes → base64 "AAAA"
    print!(
        "\x1b_Ga=T,f=24,s=1,v=1,i=9,c=1,r=1;{payload}\x1b\\",
        payload = base64::engine::general_purpose::STANDARD
            .encode([0u8, 0u8, 0u8])
    );
    print!("\x1b[>q\x1b[c"); // version query + DA1 as fallback signals
    let _ = std::io::stdout().flush();

    let mut fd_vec = [libc::pollfd {
        fd: 0,
        events: libc::POLLIN,
        revents: 0,
    }];
    let deadline = Instant::now() + Duration::from_millis(800);
    let mut seen = String::new();
    let mut saw_kitty_ack = false;
    let mut saw_da = false;
    while Instant::now() < deadline && !saw_da {
        let left = deadline.saturating_duration_since(Instant::now());
        let ms = left.as_millis() as i32;
        let r = unsafe { libc::poll(fd_vec.as_mut_ptr(), 1, ms) };
        if r <= 0 {
            break;
        }
        let mut buf = [0u8; 256];
        let n = unsafe { libc::read(0, buf.as_mut_ptr() as *mut libc::c_void, buf.len()) };
        if n <= 0 {
            break;
        }
        seen.push_str(&String::from_utf8_lossy(&buf[..n as usize]));
        if seen.contains("\x1b_Gi=9") {
            saw_kitty_ack = true;
            break;
        }
        if seen.contains('<') && seen.contains('>') {
            saw_da = true;
        }
    }
    let _ = crossterm::terminal::disable_raw_mode();
    if keep_raw && saw_kitty_ack {
        // Re-enable and keep raw mode: the video loop's ACK flow control needs
        // it. The caller is responsible for disabling on exit.
        let _ = crossterm::terminal::enable_raw_mode();
    }

    // Clean up the probe image (delete by id)
    print!("\x1b_Ga=d,d=i,i=9\x1b\\");
    let _ = std::io::stdout().flush();

    if saw_kitty_ack {
        return (true, true);
    }

    // Secondary signal: iTerm2 ≥ 3.6.9 shipped kitty support (release notes).
    if let Some((maj, min, pat)) = parse_iterm2_version(&seen) {
        if maj > 3 || (maj == 3 && (min > 6 || (min == 6 && pat >= 9))) {
            return (true, false);
        }
    }
    if !seen.is_empty() {
        eprintln!("  [probe] no kitty ACK; terminal replied: {:?}", seen);
    }
    (false, false)
}

/// Extract `iTerm2 X.Y.Z` from a CSI > q response, if present.
fn parse_iterm2_version(responses: &str) -> Option<(u32, u32, u32)> {
    let idx = responses.find("iTerm2")?;
    let rest = responses[idx + 6..].trim_start(); // skip the space before version
    let v: String = rest
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    let mut it = v.split('.');
    let maj = it.next()?.parse().ok()?;
    let min = it.next().unwrap_or("0").parse().ok()?;
    let pat = it.next().unwrap_or("0").parse().ok()?;
    Some((maj, min, pat))
}

/// Print any terminal-side kitty error ACKs (deduped), e.g.
/// `ESC_Gi=1,p=1;EINVAL:...`. Success ACKs are counted by the caller instead.
fn report_kitty_replies(replies: &str, last_err: &mut Option<String>) {
    for seg in replies.split('\u{1b}') {
        let Some(body) = seg.strip_prefix("_G") else { continue };
        let Some((_, status)) = body.split_once(';') else { continue };
        let status = status.split('\u{1b}').next().unwrap_or("");
        if status == "OK" || status.is_empty() {
            continue;
        }
        let printable: String = status.chars().filter(|c| c.is_ascii_graphic() || *c == ' ').collect();
        if last_err.as_deref() != Some(printable.as_str()) {
            *last_err = Some(printable.clone());
            eprintln!("  [kitty] terminal rejected a frame: {printable}");
        }
    }
}

/// Read whatever the terminal replies to stdin for up to `ms`.
/// Caller must have raw mode enabled. Returns lossy-decoded bytes.
fn read_replies_window(ms: u64) -> String {
    let mut seen = String::new();
    let deadline = Instant::now() + Duration::from_millis(ms);
    loop {
        let mut fd_vec = [libc::pollfd {
            fd: 0,
            events: libc::POLLIN,
            revents: 0,
        }];
        let left = deadline.saturating_duration_since(Instant::now());
        let r = unsafe { libc::poll(fd_vec.as_mut_ptr(), 1, left.as_millis() as i32) };
        if r <= 0 {
            break;
        }
        let mut buf = [0u8; 1024];
        let n = unsafe { libc::read(0, buf.as_mut_ptr() as *mut libc::c_void, buf.len()) };
        if n <= 0 {
            break;
        }
        seen.push_str(&String::from_utf8_lossy(&buf[..n as usize]));
        if Instant::now() >= deadline {
            break;
        }
    }
    seen
}

/// Render test blocks via kitty graphics — verification matrix for iTerm2.
///
///   V1  red,   our encoder, raw f=24 (the byte shape proven working)
///   V2  green, our encoder, o=z compressed (bandwidth option)
///   V3  blue,  independent single-chunk reference clone (python-style)
///
/// Every variant uses q=0 so the terminal MUST ACK/error — no silent drops.
pub fn kitty_selftest() -> anyhow::Result<()> {
    use std::io::Write as _;

    let (kitty_ok, probe_ack) = probe_kitty_support(false);
    if !kitty_ok {
        println!("✗ kitty graphics NOT detected on this terminal.");
        println!("  iTerm2 3.6.9+ ships it — this shell may not be iTerm2.");
        return Ok(());
    }

    let raw = crossterm::terminal::enable_raw_mode().is_ok();
    let mut notes: Vec<String> = Vec::new();
    notes.push(format!(
        "probe ACK seen: {probe_ack}{}",
        if probe_ack { "" } else { " (kitty usable via iTerm2 version fallback)" }
    ));

    let mut enc = KittyEnc::new();
    enc.quiet = 0; // matrix demands replies for every frame
    let mut out = Vec::new();

    // ── V1: raw f=24 red, i=1, at row 2 ─────────────────────────────────────
    print!("\x1b[H\x1b[2J");
    print!("\x1b[2;2H");
    let rgb_red: Vec<u8> = [220u8, 60, 60].repeat(16); // 4×4 px
    enc.img_id = 1;
    enc.placement_id = 1;
    enc.compress = false;
    enc.encode_into(&rgb_red, 4, 4, 30, 8, &mut out);
    std::io::stdout().write_all(&out)?;
    std::io::stdout().flush()?;
    let r1 = if raw { read_replies_window(700) } else { String::new() };

    // ── V2: o=z compressed green, i=2, at row 12 ────────────────────────────
    print!("\x1b[12;2H");
    let rgb_green: Vec<u8> = [40u8, 200, 40].repeat(16);
    enc.img_id = 2;
    enc.placement_id = 2;
    enc.compress = true;
    enc.encode_into(&rgb_green, 4, 4, 30, 8, &mut out);
    std::io::stdout().write_all(&out)?;
    std::io::stdout().flush()?;
    let r2 = if raw { read_replies_window(700) } else { String::new() };

    // ── V3: independent python-style single-chunk blue, i=93, at row 22 ─────
    let px: Vec<u8> = [40u8, 80, 220].repeat(32 * 32); // 32×32 f=24 = 3072 B
    let b64 = B64.encode(&px); // 4096 chars — exactly one chunk
    print!(
        "\x1b[22;2H\x1b_Ga=T,f=24,s=32,v=32,i=93,c=30,r=8,m=0;{b64}\x1b\\"
    );
    std::io::stdout().flush()?;
    let r3 = if raw { read_replies_window(700) } else { String::new() };

    // ── cleanup + report ────────────────────────────────────────────────────
    print!("\x1b_Ga=d\x1b\\\x1b_Ga=d,d=a\x1b\\");
    std::io::stdout().flush()?;
    let _ = crossterm::terminal::disable_raw_mode();
    println!("\x1b[33;1H\x1b[J");
    let fmt = |r: &String| {
        if r.is_empty() {
            "SILENT".to_string()
        } else {
            format!("{:?}", r.replace('\x1b', "<ESC>"))
        }
    };
    println!("════════ kitty frame matrix ════════");
    for line in &notes {
        println!("  {line}");
    }
    println!("  V1 red   (raw,  i=1)  : {}", fmt(&r1));
    println!("  V2 green (o=z,  i=2)  : {}", fmt(&r2));
    println!("  V3 blue  (raw,  i=93) : {}", fmt(&r3));
    println!("------------------------------------");
    println!("Which blocks rendered? red=V1 green=V2 blue=V3.");
    println!("All three ⇒ kitty pipeline ready — run the webcam (--size 1280x720).");
    Ok(())
}

/// Open + configure a camera stream at the requested resolution.
fn open_camera(device: u32, w: u32, h: u32) -> anyhow::Result<Camera> {
    let requested = RequestedFormat::new::<RgbFormat>(RequestedFormatType::Closest(
        CameraFormat::new(Resolution::new(w, h), FrameFormat::YUYV, 30),
    ));
    let mut camera = Camera::new(CameraIndex::Index(device), requested)
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    camera
        .open_stream()
        .map_err(|e| anyhow::anyhow!("lock/failed to open: {e}"))?;
    Ok(camera)
}

/// Terminal + camera layout snapshot. Recomputed whenever the window resizes
/// (polled per frame — SIGWINCH-free, robust under raw mode).
struct Geometry {
    cols: usize,
    rows: usize,
    avail_rows: usize,
    ws_px_w: usize,
    ws_px_h: usize,
    box_w: usize,
    box_h: usize,
    box_aspect: f32,
    max_enc_w: usize,
    max_enc_h: usize,
    cell_w: usize,
    cell_h: usize,
    tdisp_w: usize,
    tdisp_h: usize,
    crop_x: usize,
    crop_y: usize,
    crop_w: usize,
    crop_h: usize,
}

fn compute_geometry(
    cols: usize,
    rows: usize,
    cam_w: usize,
    cam_h: usize,
    format: Format,
) -> Geometry {
    let cam_aspect = cam_w as f32 / cam_h as f32;
    // The video lives INSIDE the app frame: header(1) + bottom border(1) +
    // buttons(1) rows of chrome; 1 col inset on each side for the frame
    // verticals. `cols` arrives pre-trimmed (ui::video_cols).
    let reserved = crate::ui::deck_rows() as usize;
    let avail_rows = rows.saturating_sub(reserved).max(1);
    let (ws_px_w, ws_px_h) = window_pixel_size();
    let cell_px_h = if rows > 0 { ws_px_h / rows } else { 0 };
    let avail_px_h = cell_px_h * avail_rows;
    let px_per_cell_w = if cols > 0 { ws_px_w / cols } else { 0 };

    // The drawing box: the video region's pixels (not the whole window).
    let region_px_w = px_per_cell_w * cols;
    let (box_w, box_h) = if region_px_w > 100 && avail_px_h > 60 {
        (region_px_w, avail_px_h)
    } else {
        // Fallback: 480x270-ish box in cam aspect
        let pw = ((270.0_f32 * cam_aspect).round() as usize).clamp(320, 960);
        (pw & !1, 270)
    };
    let box_aspect = box_w as f32 / box_h as f32;

    // ── Text-mode cell sizing ─────────────────────────────────────────────
    let (cell_w, cell_h) = match format {
        Format::Quadrant | Format::HalfBlock => {
            // Each terminal row renders 2 (half) or 2×2 (quadrant) pixel rows —
            // the art must fit inside avail_rows or the terminal scrolls and
            // wipes the TUI frame.
            let fit_w = ((2.0 * cam_aspect) * avail_rows as f32).round() as usize;
            let fit_h = (avail_rows / 2).max(1);
            if fit_w <= cols && fit_w >= 1 {
                (fit_w, fit_h)
            } else {
                let ch = (((cols as f32) / (2.0 * cam_aspect)).round() as usize)
                    .max(1)
                    .min(fit_h);
                (cols.max(1), ch)
            }
        }
        _ => (0, 0),
    };
    let (tdisp_w, tdisp_h) = match format {
        Format::Quadrant => (cell_w * 2, cell_h * 2),
        Format::HalfBlock => (cell_w, cell_h * 2),
        _ => (0, 0), // image formats use cur_w/cur_h directly
    };

    // ── Center-crop the camera to the drawing aspect (cover-fit, no disto) ────
    let (crop_x, crop_y, crop_w, crop_h) = if cam_aspect > box_aspect {
        let cw = ((cam_h as f32) * box_aspect).floor() as usize;
        ((cam_w - cw) / 2, 0, cw, cam_h)
    } else {
        let ch = ((cam_w as f32) / box_aspect).floor() as usize;
        (0, (cam_h - ch) / 2, cam_w, ch)
    };

    Geometry {
        cols,
        rows,
        avail_rows,
        ws_px_w,
        ws_px_h,
        box_w,
        box_h,
        box_aspect,
        max_enc_w: box_w.min(cam_w),
        max_enc_h: box_h.min(cam_h),
        cell_w,
        cell_h,
        tdisp_w,
        tdisp_h,
        crop_x,
        crop_y,
        crop_w,
        crop_h,
    }
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Format {
    Kitty,     // kitty graphics — real pixels, memory-bounded, iTerm2 3.6+
    Sixel,     // sixel graphics (WezTerm/mlterm)
    Iterm,     // OSC-1337 inline (⚠️ iTerm2 leaks: gitlab #10420)
    Quadrant,  // 2x2 px per cell text art
    HalfBlock, // 1x2 px per cell text art
}

/// Everything the render loop needs; parsed once in main.
#[derive(Clone, Copy, Debug)]
pub struct VideoOpts {
    pub device: u32,
    pub w: u32,
    pub h: u32,
    pub format: Format,
    pub fps: u32,
    pub keep_mirrored: bool,
    /// Synthetic moving pattern instead of a real camera (test/CI).
    pub fake_cam: bool,
}

pub fn parse_format(s: &str) -> Format {
    match s {
        "kitty" => Format::Kitty,
        "sixel" => Format::Sixel,
        "iterm" => Format::Iterm,
        "half" => Format::HalfBlock,
        "quad" => Format::Quadrant,
        _ => {
            let term_prog = std::env::var("TERM_PROGRAM").unwrap_or_default();
            if term_prog.contains("iTerm") {
                Format::Kitty
            } else {
                Format::Quadrant
            }
        }
    }
}

/// Drain + execute queued user actions. Shared by the render loop and the
/// receive-only spin loop.
pub fn process_actions() {
// ── User actions (mouse clicks / keys) ──────────────────────────
    while let Some(action) = crate::ui::poll_action() {
        match action {
            crate::ui::Action::ToggleCamera => {
                let on = !crate::ui::camera_on();
                crate::ui::set_camera_on(on);
                if on {
                    overlay_log("📷 camera on — publishing again");
                } else {
                    overlay_log("📷 camera off — press c to enable");
                }
                crate::rtc::broadcast_media_state(
                    crate::audio::mic_on(),
                    on,
                );
            }
            crate::ui::Action::ToggleMic => {
                let on = !crate::audio::mic_on();
                crate::audio::set_mic_on(on);
                if on {
                    overlay_log("🎙 mic on");
                } else {
                    overlay_log("🎙 mic muted");
                }
                crate::rtc::broadcast_media_state(on, crate::ui::camera_on());
            }
            crate::ui::Action::CopyCode => {
                let code = crate::ui::room_code();
                if !code.is_empty() {
                    let b64 = B64.encode(code.as_bytes());
                    {
                        use std::io::Write;
                        let _ = write!(std::io::stdout(), "\x1b]52;c;{b64}\x07");
                        let _ = std::io::stdout().flush();
                    }
                    let _ = std::io::stdout().flush();
                    overlay_log("📋 room code copied to clipboard");
                }
            }
            crate::ui::Action::OpenChat => {
                // Toggle: the button closes the panel as well as opens it.
                crate::ui::set_typing(!crate::ui::typing());
            }
            crate::ui::Action::CloseChat => {
                crate::ui::set_typing(false);
            }
            crate::ui::Action::SendChat(text) => {
                if crate::rtc::send_chat(&text) {
                    // The server echo renders it — no local push (no dup).
                } else {
                    crate::ui::push_event("⚠️ message not sent — no connection");
                }
            }
            crate::ui::Action::Leave => {
                overlay_log("👋 leaving the call…");
                RUNNING.store(false, Ordering::SeqCst);
            }
        }
    }
}

pub fn webcam_render(opts: VideoOpts) -> anyhow::Result<()> {
    init_rtc_file_logger();
    let VideoOpts { device, w: req_w, h: req_h, mut format, fps: fps_arg, keep_mirrored, fake_cam } = opts;
    // Capture at ≤640×480: the software YUV→RGB conversion scales with pixel
    // count and 720p alone ate 150-250ms/frame. Peers render us small anyway
    // (their tiles are ~480×360); pass --size 1280x720 for hi-res capture.
    let (req_w, req_h) = (req_w.min(640), req_h.min(480));

    // Capability probe for kitty: confirmed terminals hold raw mode for the
    // ACK flow-control loop; without kitty we fall back silently to quadrant.
    if format == Format::Kitty {
        let (usable, _ack) = probe_kitty_support(true);
        if !usable {
            let _ = crossterm::terminal::disable_raw_mode();
            eprintln!();
            eprintln!("  ⚠️  This terminal doesn't support kitty graphics (or support is disabled).");
            eprintln!("  → Falling back to quadrant text mode (use --format sixel/quad to override).");
            format = Format::Quadrant;
        }
    }

    let (cols0, rows0) = crossterm::terminal::size()
        .map(|(c, r)| (c as usize, r as usize))
        .unwrap_or((100, 50));
    let mut geom: Geometry;
    let mut last_cells: (usize, usize, bool) = (0, 0, false);
    let mut last_px: (usize, usize) = (0, 0);

    // ── FPS target: default per format ────────────────────────────────────
    let target_fps = if fps_arg == 0 {
        match format {
            Format::Kitty | Format::Iterm | Format::Sixel => 15,
            _ => 30,
        }
    } else {
        fps_arg.clamp(1, 60)
    };
    let target_ms = 1000.0f64 / target_fps as f64;

    // ── Open camera (or synthesize frames for --fake-cam) ─────────
    let (cam_w, cam_h, camera) = if opts.fake_cam {
        overlay_log("🧪 fake camera: publishing a synthetic pattern");
        eprintln!("Camera active: fake 640x480 @ 25fps");
        (640usize, 480usize, None)
    } else {
        // Resolution fallback + retries: "Lock Rejected" happens when another
        // process (or a hung previous instance) still holds the camera — a
        // short retry loop rides that out, and each attempt releases on drop.
        overlay_log(&format!("Opening camera {} at {}x{}...", device, req_w, req_h));
        let mut camera = None;
        for (w, h) in [(req_w, req_h), (640, 480)] {
            for attempt in 1..=3 {
                match open_camera(device, w, h) {
                    Ok(c) => {
                        camera = Some(c);
                        break;
                    }
                    Err(e) => {
                        eprintln!("  camera {w}x{h} (attempt {attempt}/3) failed: {e}");
                        std::thread::sleep(Duration::from_millis(900));
                    }
                }
            }
            if camera.is_some() {
                break;
            }
            if w != 640 {
                overlay_log(&format!("{w}x{h} unavailable, trying 640x480…"));
            }
        }
        let Some(mut camera) = camera else {
            anyhow::bail!(
                "Could not open the camera. It may be in use by another app — or \
                 another uplink-terminal session is still running (kill it with \
                 'pkill uplink-terminal') — then retry."
            );
        };
        let cam_fmt = camera.camera_format();
        let cam_w = cam_fmt.resolution().width_x as usize;
        let cam_h = cam_fmt.resolution().height_y as usize;
        eprintln!("Camera active: {cam_w}x{cam_h} @ {}fps", cam_fmt.frame_rate());
        (cam_w, cam_h, Some(camera))
    };
    let mut camera = camera;

    // Recompute geometry now that the real camera size is known.
    geom = compute_geometry(
        crate::ui::video_cols(cols0 as u16) as usize,
        rows0,
        cam_w,
        cam_h,
        format,
    );
    last_cells = (cols0, rows0, false);
    last_px = window_pixel_size();

    // ── Encode size (auto-tuned); geometry lives in `geom` (resize-aware) ──
    // NEVER upscale beyond camera native — iTerm2 upscales losslessly on
    // display, and encoding megapixels the camera doesn't have is pure waste.
    const MIN_ENC_W: usize = 480;
    const MIN_ENC_H: usize = 270;
    // Kitty video starts bounded so the PTY backlog never explodes on frame 1;
    // auto-tune grows toward max when the terminal proves it can keep up.
    let init_cap_w = if format == Format::Kitty { 960usize } else { usize::MAX };
    let mut cur_w = geom.max_enc_w.min(init_cap_w) & !1;
    let mut cur_h = (((cur_w as f32 / geom.box_aspect).round() as usize) & !1)
        .clamp(MIN_ENC_H, geom.max_enc_h.max(MIN_ENC_H));

    let mode_label = match format {
        Format::Kitty => "kitty graphics",
        Format::Sixel => "sixel",
        Format::Iterm => "iterm inline",
        Format::Quadrant => "quad 2x2",
        Format::HalfBlock => "half 1x2",
    };
    overlay_log(&format!(
        "Display: box {}x{}px | encode {}x{} | <={}fps [{}] | Ctrl+C to quit",
        geom.box_w, geom.box_h, cur_w, cur_h, target_fps, mode_label
    ));

    // ── Reusable buffers — allocated once, resized only when auto-tune shrinks ─
    let mut small_buf: Vec<u8> = Vec::with_capacity(cur_w * cur_h * 3);
    let mut small_buf_top: Vec<u8> = Vec::with_capacity(cur_w * (cur_h / 2 + 1) * 3);
    let mut small_buf_peer: Vec<u8> = Vec::with_capacity(cur_w * (cur_h / 2 + 1) * 3);
    let mut jpg_buf: Vec<u8> = Vec::with_capacity(256 * 1024);
    let mut sixel_enc = SixelEnc::new();
    let mut sixel_buf: Vec<u8> = Vec::with_capacity(512 * 1024);
    // q=0: every frame is ACKed back to us over stdin. We consume them —
    // nothing re-echoes — and they power flow control + error surfacing.
    let mut kitty_enc = KittyEnc::new();
    kitty_enc.set_quiet(0);
    // Raw f=24 is cheapest to ENCODE but ~3.7MB of base64 at 720p — far beyond
    // iTerm2's sustained PTY throughput. o=z (proven: green box in the
    // matrix) compresses camera frames 3-5× at ~5ms/frame CPU.
    // UPLINK_KITTY_RAW=1 forces raw f=24 for byte-level debugging.
    if std::env::var("UPLINK_KITTY_RAW").as_deref() == Ok("1") {
        kitty_enc.compress = false;
        eprintln!("  [kitty] raw f=24 (UPLINK_KITTY_RAW=1)");
    } else {
        kitty_enc.compress = true;
    }
    // Video frames MUST carry an explicit placement id: iTerm2 replaces the
    // placement per frame; with p omitted it stacks one per frame and the
    // renderer drowns in overlapping layers.
    kitty_enc.placement_id = 1;
    let mut kitty_buf: Vec<u8> = Vec::with_capacity(512 * 1024);
    std::io::stdout().flush()?;

    let mut frame_count: u64 = 0;
    let start = Instant::now();
    let mut last_fps_update = Instant::now();

    // ── Auto-tune state: measure WORK time (not paced), adapt encode size ─────
    const WIN_FRAMES: u32 = 10;
    let mut win_frames = 0u32;
    let mut win_sum_ms = 0.0f64;
    let mut grow_streak = 0u32;
    let encode_quality: u8 = 80; // jpeg quality — iterm mode only
    let mut outq_streak: u32 = 0;
    // ── ACK-window flow control (kitty) ──────────────────────────────────
    // iTerm2 ACKs every frame (q=0). Hold at most ACK_WINDOW frames in
    // flight: when the terminal lags, we stop sending and let its ACKs pace
    // us. Auto-tune sees the stall as work time and shrinks the frame until
    // the terminal sustains the target fps.
    const ACK_WINDOW: u64 = 3;
    let (mut sent, mut acked) = (0u64, 0u64);
    let mut last_err: Option<String> = None;

    let pacing = Duration::from_nanos((1_000_000_000.0 / target_fps as f64) as u64);

    // ── TUI: raw mode + mouse capture + keyboard/ACK input thread ────────
    // Raw for ALL formats: mouse/keys are line-buffered without it.
    let _ = crossterm::terminal::enable_raw_mode();
    crate::ui::enter_ui();
    crate::ui::start_input_thread();
    // Wipe previous sessions' text: iTerm2 composites text OVER inline
    // images, so leftover prompt/exit lines bleed through the video.
    print!("\x1b[2J\x1b[H");
    let _ = std::io::stdout().flush();

    while RUNNING.load(Ordering::SeqCst) {
        let tick = Instant::now();

        crate::video::process_actions();


        // ── Window resize (SIGWINCH-free polling) ─────────────────────────
        {
            let (nc, nr) = crossterm::terminal::size()
                .map(|(c, r)| (c as usize, r as usize))
                .unwrap_or((geom.cols, geom.rows));
            let (nw, nh) = window_pixel_size();
            let chat = crate::ui::typing();
            let cells_changed = (nc, nr, chat) != last_cells;
            let px_changed = (nw, nh) != last_px;
            if cells_changed || px_changed {
                last_cells = (nc, nr, chat);
                last_px = (nw, nh);
                geom = compute_geometry(
                    crate::ui::video_cols(nc as u16) as usize,
                    nr,
                    cam_w,
                    cam_h,
                    format,
                );
                cur_w = cur_w.min(geom.max_enc_w & !1).max(MIN_ENC_W);
                cur_h = (((cur_w as f32 / geom.box_aspect).round() as usize) & !1)
                    .clamp(MIN_ENC_H, geom.max_enc_h.max(MIN_ENC_H));
                overlay_log(&format!(
                    "resize → {}x{} cells ({}x{}px) │ encode {cur_w}x{cur_h}",
                    geom.cols, geom.rows, geom.ws_px_w, geom.ws_px_h
                ));
                if cells_changed {
                    // Cell grid or chat state changed: wipe stale video/text
                    // and force the TUI to repaint from scratch.
                    print!("\x1b[2J\x1b[H");
                    let _ = std::io::stdout().flush();
                    crate::ui::reset_terminal();
                    win_frames = 0;
                    win_sum_ms = 0.0;
                    outq_streak = 0;
                    grow_streak = 0;
                }
            }
        }

        // ── Flow-control gate: never queue more than ACK_WINDOW frames ──────
        // ACKs are consumed continuously by the ui input thread.
        acked = crate::ui::acked();
        for err in crate::ui::take_kitty_errors() {
            if last_err.as_deref() != Some(err.as_str()) {
                last_err = Some(err.clone());
                overlay_log(&format!("⚠️ [kitty] {err}"));
            }
        }
        if format == Format::Kitty && sent.saturating_sub(acked) >= ACK_WINDOW {
            continue; // terminal still backed up — drop this tick
        }

        let raw: Vec<u8>;
        if camera.is_none() {
            // Fake camera: drifting color wash + moving stripes, mirrored
            // corner marker so motion is obvious.
            let t = tick.elapsed().as_secs_f32();
            let mut buf = vec![0u8; cam_w * cam_h * 3];
            for y in 0..cam_h {
                for x in 0..cam_w {
                    let o = (y * cam_w + x) * 3;
                    let wave = ((x as f32 + t * 80.0) / 24.0).sin();
                    let stripe = if ((x + y) / 37) % 2 == 0 { 30 } else { 0 };
                    buf[o] = (90.0 + 60.0 * wave) as u8;
                    buf[o + 1] = (60 + stripe + (y * 255 / cam_h) as u8 / 3) as u8;
                    buf[o + 2] = (140.0 + 40.0 * wave) as u8;
                }
            }
            raw = buf;
        } else {
            let frame = match camera.as_mut().unwrap().frame() {
                Ok(f) => f,
                Err(_) => continue,
            };
            let image = match frame.decode_image::<RgbFormat>() {
                Ok(img) => img,
                Err(_) => continue,
            };
            raw = image.as_raw().to_vec();
        }
        let raw = &raw[..];

        // Offer the frame to the webrtc publishers (copy only when someone
        // is actually connected — keeps camera-only renders copy-free).
        if publishers_active() && crate::ui::camera_on() {
            publish_camera_frame(cam_w as u32, cam_h as u32, Arc::new(raw.to_vec()));
        }

        // Camera frame + optional inbound peer video, composed side-by-side
        // (stacked: camera on top, peer below) into one kitty placement.
        // ── Encode buffers must track auto-tune/resize — the frame size is
        //    recomputed here every iteration (auto-tune can GROW cur_w/cur_h
        //    past the initial allocation; stale buffers = slice OOB panic).
        let need_full = cur_w * cur_h * 3;
        if small_buf.len() < need_full {
            small_buf.resize(need_full, 0);
        }
        // ── Grid of tiles: [local] + up to 3 fresh peer streams ──────────
        let peers = fresh_peer_frames();
        let n_peers = peers.len();
        let cam_renderable = crate::ui::camera_on();
        // Grid geometry (cols, rows) of tiles:
        let (gcols, grows) = match n_peers {
            0 => (1, 1),
            1 => {
                if geom.cols * 5 >= geom.avail_rows * 6 {
                    (2, 1) // wide → side-by-side (Meet-style)
                } else {
                    (1, 2)
                }
            }
            _ => (2, 2), // 2-3 peers → 2×2 with the local tile first
        };
        crate::ui::set_tile_grid(gcols as u16, grows as u16);
        // Tile names in cell order: local first, then peers by ssrc label.
        let local_name = crate::ui::local_label();
        let mut names = vec![local_name];
        for p in &peers {
            let id = crate::rtc::ssrc_peer_name(p.ssrc as u32);
            let name = id
                .as_deref()
                .and_then(crate::ui::name_for_socket)
                .unwrap_or_else(|| "peer".into());
            names.push(name);
        }
        crate::ui::set_tile_names(names);

        // ── Letterboxed 16:9 tiles, grid centered in the region ───────────
        // Every real meeting app keeps tiles at 16:9 (matching cameras) and
        // pads the leftover region with bars — instead of stretching the
        // crop to fill a wide terminal (which crops 70% of the frame).
        const TILE_ASPECT: f32 = 16.0 / 9.0;
        let max_cell_w = (cur_w / gcols) & !1;
        let max_cell_h = (cur_h / grows) & !1;
        let (cell_w, cell_h) = if max_cell_w as f32 / max_cell_h as f32 > TILE_ASPECT {
            let w = ((max_cell_h as f32) * TILE_ASPECT) as usize & !1;
            (w.min(max_cell_w), max_cell_h)
        } else {
            let h = ((max_cell_w as f32) / TILE_ASPECT) as usize & !1;
            (max_cell_w, h.min(max_cell_h))
        };
        let content_w = cell_w * gcols;
        let content_h = cell_h * grows;
        let ox = ((cur_w - content_w) / 2) & !1;
        let oy = ((cur_h - content_h) / 2) & !1;
        // Metrics in SCREEN CELLS: the encode buffer maps linearly over the
        // region (image stretches to geom.cols × avail_rows).
        let cell_of = |px: usize, total: usize, cells: usize, base: usize| -> u16 {
            ((px * cells) / total.max(1) + base) as u16
        };
        crate::ui::set_tile_metrics(
            cell_of(ox, cur_w, geom.cols, 1) + 1,       // +1 for the frame inset
            cell_of(oy, cur_h, geom.avail_rows, 1),
            cell_of(cell_w, cur_w, geom.cols, 0).max(2),
            cell_of(cell_h, cur_h, geom.avail_rows, 0).max(1),
        );

        let stride = cur_w * 3;
        {
            let need = cur_w * cur_h * 3;
            if small_buf.len() < need {
                small_buf.resize(need, 0);
            }
            let cell_need = cell_w.max(cur_w) * (cell_h + 1) * 3;
            if small_buf_top.len() < cell_need {
                small_buf_top.resize(cell_need, 0);
            }
        }
        small_buf[..cur_w * cur_h * 3].fill(0); // bars

        macro_rules! blit {
            ($src:expr, $sw:expr, $sh:expr, $gx:expr, $gy:expr, $mirror:expr) => {{
                let src: &[u8] = $src;
                let (sw, sh, gx, gy) = ($sw, $sh, $gx, $gy);
                let mirror: bool = $mirror;
                let tw = cell_w;
                let th = cell_h;
                let target_aspect = tw as f32 / th as f32;
                let src_aspect = sw as f32 / sh as f32;
                let (sx0, sy0, sw2, sh2) = if src_aspect > target_aspect {
                    let cw = ((sh as f32) * target_aspect).floor() as usize;
                    ((sw - cw) / 2, 0, cw.min(sw), sh)
                } else {
                    let ch = ((sw as f32) / target_aspect).floor() as usize;
                    (0, (sh - ch) / 2, sw, ch.min(sh))
                };
                downscale_box_into(
                    src, sw, sx0, sy0, sw2, sh2, tw, th, mirror, &mut small_buf_top,
                );
                let cstride = tw * 3;
                let x0 = ox + gx * cell_w;
                let y0 = oy + gy * cell_h;
                for r in 0..th.min(sh.max(th)) {
                    let s = r * cstride;
                    let d = (y0 + r) * stride + x0 * 3;
                    if d + cstride <= small_buf.len() && s + cstride <= small_buf_top.len() {
                        small_buf[d..d + cstride].copy_from_slice(&small_buf_top[s..s + cstride]);
                    }
                }
            }};
        }

        // Tile 0: local camera (or the cam-off card).
        if !cam_renderable {
            draw_cam_off(&mut small_buf_top, cell_w, cell_h);
            let cstride = cell_w * 3;
            for r in 0..cell_h {
                let s = r * cstride;
                let d = (oy + r) * stride + ox * 3;
                if d + cstride <= small_buf.len() && s + cstride <= small_buf_top.len() {
                    small_buf[d..d + cstride].copy_from_slice(&small_buf_top[s..s + cstride]);
                }
            }
        } else {
            blit!(raw, cam_w, cam_h, 0, 0, !keep_mirrored);
        }

        for (i, p) in peers.iter().enumerate() {
            let gx = (i + 1) % gcols;
            let gy = (i + 1) / gcols;
            blit!(p.rgb.as_slice(), p.w as usize, p.h as usize, gx, gy, false);
        }

        // Separators between cells.
        if gcols > 1 {
            for r in 0..cur_h {
                for gc in 1..gcols {
                    let o = r * stride + (gc * cell_w) * 3;
                    if o + 3 <= small_buf.len() {
                        small_buf[o] = 110;
                        small_buf[o + 1] = 115;
                        small_buf[o + 2] = 125;
                    }
                }
            }
        }
        if grows > 1 {
            for gr in 1..grows {
                let row = (gr * cell_h) * stride;
                for x in 0..(cur_w * 3).min(small_buf.len() - row) {
                    small_buf[row + x] = 110;
                }
            }
        }

        match format {
            Format::Kitty => {
                // Raw RGB + zlib → kitty APC. Same image id / placement id every
                // frame → iTerm2 replaces in place (bounded memory, no flicker).
                // Placed inside the frame: row 2, col 2, geom.cols × avail cells.
                kitty_enc.encode_into(
                    &small_buf,
                    cur_w,
                    cur_h,
                    geom.cols,
                    geom.avail_rows,
                    &mut kitty_buf,
                );
                print!("\x1b[2;2H");
                std::io::stdout().write_all(&kitty_buf)?;
                sent += 1;
            }
            Format::Iterm => {
                // Encode small JPEG; iTerm2 scales it to fill the whole
                // terminal pixel box on draw.
                encode_jpeg_into(&small_buf, cur_w, cur_h, encode_quality, &mut jpg_buf);
                let b64 = B64.encode(&jpg_buf);
                print!(
                    "\x1b[2;2H\x1b]1337;File=inline=1&doNotMoveCursor=1&preserveAspectRatio=0&width={bw}px&height={bh}px&size={sz}:{b64}\x07",
                    bw = geom.box_w,
                    bh = geom.box_h,
                    sz = b64.len(),
                );
            }
            Format::Sixel => {
                sixel_enc.encode_into(&small_buf, cur_w, cur_h, 64, &mut sixel_buf);
                print!("\x1b[2;2H");
                std::io::stdout().write_all(&sixel_buf)?;
            }
            Format::Quadrant | Format::HalfBlock => {
                let ansi = match format {
                    Format::Quadrant => render_quadrant(&small_buf, geom.tdisp_w, geom.tdisp_h),
                    _ => render_ansi(&small_buf, geom.tdisp_w, geom.tdisp_h),
                };
                print!("\x1b[2;2H{ansi}");
            }
        }
        std::io::stdout().flush()?;

        frame_count += 1;
        let work_ms = tick.elapsed().as_secs_f64() * 1000.0;

        // ── Terminal backpressure: is iTerm2 keeping up with our bytes? ─────
        // TIOCOUTQ = bytes queued in the pty that iTerm2 hasn't read yet. If
        // the queue stays saturated, the TERMINAL is the bottleneck: yield a
        // few ms so it drains, and let auto-tune shrink the frame size.
        if format == Format::Kitty {
            let q_now: usize = unsafe {
                let mut v: libc::c_int = 0;
                libc::ioctl(libc::STDOUT_FILENO, libc::TIOCOUTQ, &mut v);
                v.max(0) as usize
            };
            if q_now > 32_768 {
                outq_streak += 1;
                std::thread::sleep(Duration::from_millis(8));
            } else {
                outq_streak = 0;
            }
        }

        // ── Status deck ─────────────────────────────────────────────────────
        if last_fps_update.elapsed() >= Duration::from_millis(500) {
            let elapsed = start.elapsed().as_secs_f64();
            let fps = frame_count as f64 / elapsed;
            crate::ui::set_stats(fps as u32, cur_w as u32, cur_h as u32);
            crate::ui::set_call_secs(start.elapsed().as_secs());
            last_fps_update = Instant::now();
        }
        // Deck: controls + info + 2 event tickers (mouse/keyboard enabled).
        crate::ui::paint_deck();

        // ── Auto-tune: shrink when slow, grow back when there's headroom ──────
        if matches!(format, Format::Kitty | Format::Iterm | Format::Sixel) {
            win_frames += 1;
            win_sum_ms += work_ms;
            if win_frames >= WIN_FRAMES {
                let avg = win_sum_ms / win_frames as f64;
                let term_backlog = outq_streak >= WIN_FRAMES - 2;
                if (avg > target_ms * 1.25 || term_backlog) && cur_w > MIN_ENC_W {
                    // Too slow (us) or terminal can't drain — shrink 20%
                    cur_w = (((cur_w as f32) * 0.8) as usize & !1).max(MIN_ENC_W);
                    cur_h = (((cur_w as f32 / geom.box_aspect).round() as usize) & !1)
                        .max(MIN_ENC_H);
                    if term_backlog {
                        overlay_log(&format!(
                            "auto-tune ↓ {cur_w}x{cur_h}  (iTerm2 lagging: pty backlog in {outq_streak}/{WIN_FRAMES} frames)"
                        ));
                    } else {
                        overlay_log(&format!(
                            "auto-tune ↓ {cur_w}x{cur_h}  (encoding {avg:.0}ms/frame vs {target_ms:.0}ms budget)"
                        ));
                    }
                    grow_streak = 0;
                    outq_streak = 0;
                } else if avg < target_ms * 0.55 {
                    // Plenty of headroom → try growing 12%
                    grow_streak += 1;
                    if grow_streak >= 2 {
                        let new_w = (((cur_w as f32) * 1.12) as usize & !1)
                            .min(geom.max_enc_w & !1);
                        if new_w > cur_w {
                            let new_h = (((new_w as f32 / geom.box_aspect).round() as usize)
                                & !1)
                                .min(geom.max_enc_h);
                            if new_h > cur_h && new_h >= MIN_ENC_H {
                                overlay_log(&format!(
                                    "auto-tune ↑ {new_w}x{new_h}  (headroom: {avg:.0}ms/frame)"
                                ));
                                cur_w = new_w;
                                cur_h = new_h;
                            }
                        }
                        grow_streak = 0;
                    }
                } else {
                    grow_streak = 0;
                }
                win_frames = 0;
                win_sum_ms = 0.0;
            }
        }

        // ── Pace to target FPS ────────────────────────────────────────────────
        let spent = tick.elapsed();
        if spent < pacing {
            std::thread::sleep(pacing - spent);
        }
    }

    if let Some(mut camera) = camera.take() {
        let _ = camera.stop_stream(); // release AVFoundation promptly
    }
    // Clean exit: clear the kitty image, restore the terminal.
    if format == Format::Kitty {
        print!("\x1b_Ga=d\x1b\\");
    }
    let _ = crossterm::terminal::disable_raw_mode();
    crate::ui::exit_ui();
    print!("\x1b[?25h\n");
    std::io::stdout().flush()?;

    let elapsed = start.elapsed();
    eprintln!(
        "Captured {frame_count} frames in {:.1}s ({:.1} fps avg)",
        elapsed.as_secs_f64(),
        frame_count as f64 / elapsed.as_secs_f64()
    );

    Ok(())
}

/// Compose top (camera) + bottom (peer) halves into one RGB buffer.
fn compose_top_bottom(
    top: &[u8],
    peer: Option<&[u8]>,
    w: usize,
    top_h: usize,
    peer_h: usize,
    out: &mut [u8],
) {
    let stride = w * 3;
    let top_bytes = (top_h * stride).min(out.len()).min(top.len());
    out[..top_bytes].copy_from_slice(&top[..top_bytes]);
    let sep_row = top_h;
    if sep_row < out.len() / stride.max(1) {
        for i in 0..stride.min(out.len() - sep_row * stride) {
            out[sep_row * stride + i] = 200;
        }
    }
    if let Some(peer) = peer {
        for r in 0..peer_h {
            let src_off = r * stride;
            let dst_off = (sep_row + 1 + r) * stride;
            if dst_off + stride <= out.len() && src_off + stride <= peer.len() {
                out[dst_off..dst_off + stride].copy_from_slice(&peer[src_off..src_off + stride]);
            }
        }
    }
}

/// Compose local + peer SIDE-BY-SIDE with a 1px separator between.
fn compose_left_right(
    left: &[u8],
    right: Option<&[u8]>,
    w: usize,
    full_h: usize,
    out: &mut [u8],
) {
    let stride = w * 3;
    let half = w / 2;
    let hs = half * 3;
    for r in 0..full_h {
        // left tile
        let lsrc = r * hs;
        let ldst = r * stride;
        if ldst + hs <= out.len() && lsrc + hs <= left.len() {
            out[ldst..ldst + hs].copy_from_slice(&left[lsrc..lsrc + hs]);
        }
        // separator
        let sep = r * stride + hs;
        if sep + 3 <= out.len() {
            out[sep] = 200;
            out[sep + 1] = 200;
            out[sep + 2] = 200;
        }
        // right tile
        if let Some(right) = right {
            let rsrc = r * hs;
            let rdst = r * stride + hs + 3;
            if rdst + hs <= out.len() && rsrc + hs <= right.len() {
                out[rdst..rdst + hs].copy_from_slice(&right[rsrc..rsrc + hs]);
            }
        } else {
            let rdst = r * stride + hs + 3;
            if rdst + hs <= out.len() {
                out[rdst..rdst + hs].fill(0);
            }
        }
    }
}

/// Fill `w×h` RGB with a dark "camera off" card: subtle background + a
/// red ring with a diagonal slash, centered.
fn draw_cam_off(buf: &mut [u8], w: usize, h: usize) {
    for px in buf.chunks_exact_mut(3) {
        px[0] = 22;
        px[1] = 24;
        px[2] = 28;
    }
    // Glyph centered in the LOCAL tile (top half when split).
    let (cx, cy) = (w as f32 / 2.0, h as f32 / 4.0);
    let r = (w.min(h) as f32) * 0.22;
    let stroke = 2.5f32;
    for y in 0..h {
        for x in 0..w {
            let dx = x as f32 - cx;
            let dy = y as f32 - cy;
            let d = (dx * dx + dy * dy).sqrt();
            let ring = (d - r).abs() < stroke;
            // Slash at -45°: dy + dx ≈ 0 within tolerance.
            let slash = (dy + dx).abs() / std::f32::consts::SQRT_2 < stroke && d < r;
            if ring || slash {
                let off = (y * w + x) * 3;
                buf[off] = 220;
                buf[off + 1] = 70;
                buf[off + 2] = 90;
            }
        }
    }
}

/// Box-filter (area-average) downscale of a center-cropped source rect into a
/// reused output buffer. Zero per-frame allocations in steady state.
/// Box-filter downscale (also used by the webrtc publish path).
#[allow(clippy::too_many_arguments)]
pub fn downscale_box_into(
    rgb: &[u8],
    src_w: usize,
    crop_x: usize,
    crop_y: usize,
    crop_w: usize,
    crop_h: usize,
    dst_w: usize,
    dst_h: usize,
    flip_x: bool,
    out: &mut Vec<u8>,
) {
    if out.len() != dst_w * dst_h * 3 {
        out.clear();
        out.resize(dst_w * dst_h * 3, 0);
    }

    for dy in 0..dst_h {
        let sy0 = dy * crop_h / dst_h;
        let sy1 = ((dy + 1) * crop_h / dst_h).max(sy0 + 1);
        let row_counts = (sy1 - sy0) as u32;

        for dx in 0..dst_w {
            let sx0 = dx * crop_w / dst_w;
            let sx1 = ((dx + 1) * crop_w / dst_w).max(sx0 + 1);
            let area = row_counts * (sx1 - sx0) as u32;

            let (mut r, mut g, mut b) = (0u32, 0u32, 0u32);
            for sy in sy0..sy1 {
                let row_base = (crop_y + sy) * src_w;
                for sx in sx0..sx1 {
                    let fx = if flip_x {
                        crop_x + (crop_w - 1 - sx)
                    } else {
                        crop_x + sx
                    };
                    let i = (row_base + fx) * 3;
                    if i + 2 < rgb.len() {
                        r += rgb[i] as u32;
                        g += rgb[i + 1] as u32;
                        b += rgb[i + 2] as u32;
                    }
                }
            }
            let di = (dy * dst_w + dx) * 3;
            out[di] = (r / area) as u8;
            out[di + 1] = (g / area) as u8;
            out[di + 2] = (b / area) as u8;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_probe_version_parser() {
        assert_eq!(
            parse_iterm2_version("\x1bP>|iTerm2 3.6.11\x1b\\"),
            Some((3, 6, 11))
        );
        assert_eq!(
            parse_iterm2_version("junk\x1bP>|iTerm2 3.5.0\x1b\\ more"),
            Some((3, 5, 0))
        );
        assert_eq!(parse_iterm2_version("no version here"), None);
    }
}
