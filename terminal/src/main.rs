use std::sync::atomic::Ordering;
use std::time::Instant;

use clap::Parser;
use uplink_terminal::video::parse_format;
use uplink_terminal::{signal, video};

#[derive(Parser)]
#[command(name = "uplink-terminal", about = "Uplink — terminal-based WebRTC video call")]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,

    /// Camera device index (0 = FaceTime HD, 1 = iPhone, 3 = Screen)
    #[arg(long, short = 'd', default_value = "0", global = true)]
    device: u32,

    /// Capture resolution (falls back to 640x480 if unsupported)
    #[arg(long, default_value = "1280x720", global = true)]
    size: String,

    /// Output format:
    ///   kitty = kitty graphics (iTerm2 3.6+ — real pixels, memory-bounded)
    ///   sixel = sixel graphics (WezTerm/mlterm)
    ///   iterm = iTerm2 inline images (⚠️ leaks memory in iTerm2 — avoid)
    ///   quad  = quadrant blocks, 4px/cell (any terminal)
    ///   half  = half-blocks, 2px/cell (any terminal)
    ///   auto  = kitty in iTerm2 3.6+, quad otherwise
    #[arg(long, default_value = "auto", global = true)]
    format: String,

    /// FPS cap. 0 = auto (30 for text, 15 for image protocols + auto-tune)
    #[arg(long, default_value = "0", global = true)]
    fps: u32,

    /// Keep the camera's mirrored view (we un-mirror by default)
    #[arg(long, default_value_t = false, global = true)]
    keep_mirrored: bool,
}

#[derive(clap::Subcommand)]
enum Command {
    /// Join an existing meeting by code (camera starts after joining)
    Join {
        /// Meeting code
        code: String,
        #[arg(long, short)]
        name: Option<String>,
        /// Signaling server base URL
        #[arg(long, default_value = "http://127.0.0.1:4123")]
        server: String,
        /// Signaling only — do not start the camera after joining
        #[arg(long)]
        no_camera: bool,
        /// Publish synthetic moving frames as our camera (no real device)
        #[arg(long)]
        fake_cam: bool,
    },
    /// Create a new meeting room, join it, and start the camera
    New {
        #[arg(long, short)]
        name: Option<String>,
        /// Signaling server base URL
        #[arg(long, default_value = "http://127.0.0.1:4123")]
        server: String,
        /// Signaling only — do not start the camera after creating
        #[arg(long)]
        no_camera: bool,
        /// Publish synthetic moving frames as our camera (no real device)
        #[arg(long)]
        fake_cam: bool,
    },
    /// Render self-test blocks via the kitty graphics protocol
    TestKitty {},
    /// Headless decode self-test: join a room, decode inbound H264, write
    /// counters to a file every 500 ms, exit after --secs.
    DecodeProbe {
        /// Meeting code to join (a "browser" peer must publish video)
        code: String,
        /// Display name
        #[arg(long, short, default_value = "Probe")]
        name: String,
        /// Signaling server base URL
        #[arg(long, default_value = "http://127.0.0.1:4123")]
        server: String,
        /// Seconds to run
        #[arg(long, default_value = "20")]
        secs: u64,
        /// Where to append the JSONL counters
        #[arg(long, default_value = "/tmp/uplink-decode-probe.log")]
        out: String,
        /// Publish synthetic moving frames as our camera (no real device).
        #[arg(long)]
        fake_cam: bool,
        /// Toggle the camera off/on after N seconds (tests the stop/resume
        /// cycle end-to-end).
        #[arg(long)]
        toggle_cam_at: Option<u64>,
    },
}

fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    uplink_terminal::install_ctrlc();

    let (w, h) = video::parse_size(&cli.size);
    let opts = video::VideoOpts {
        device: cli.device,
        w,
        h,
        format: parse_format(&cli.format),
        fps: cli.fps,
        keep_mirrored: cli.keep_mirrored,
        fake_cam: false,
    };

    match cli.command {
        // Bare invocation: local camera only, no signaling.
        None => video::webcam_render(opts)?,
        Some(Command::TestKitty {}) => video::kitty_selftest()?,
        Some(Command::DecodeProbe { code, name, server, secs, out, fake_cam, toggle_cam_at }) => {
            // Production signaling + WebRTC + decode, but NO rendering/camera:
            // runs headless so automation can drive it. Every 500 ms the
            // decoded-frame counter is appended to `out`; exit code = total.
            if fake_cam {
                uplink_terminal::rtc::force_publish(true);
                // automation: pid for hang-sampling
                let _ = std::fs::write("/tmp/uplink-probe-pid", format!("{}", std::process::id()));
                let _ = std::thread::Builder::new()
                    .name("fake-cam".into())
                    .spawn(|| {
                        let (w, h) = (480u32, 360u32);
                        let mut i = 0u64;
                        loop {
                            // Honor the camera toggle (the real webcam path
                            // gates in webcam_render; the fake cam gates here).
                            if !uplink_terminal::ui::camera_on() {
                                std::thread::sleep(std::time::Duration::from_millis(100));
                                continue;
                            }
                            // BGR stripes sweeping — unambiguous motion.
                            let mut rgb = vec![0u8; (w * h * 3) as usize];
                            let band = (i * 4 % (w as u64)) as usize;
                            for row in 0..h as usize {
                                for x in 0..w as usize {
                                    let d = x.abs_diff(band);
                                    let (r, g, b) = if d < 40 {
                                        (255u8, 40u8, 40u8)
                                    } else if d < 80 {
                                        (40u8, 255u8, 40u8)
                                    } else {
                                        (40u8, 40u8, 255u8)
                                    };
                                    let off = (row * w as usize + x) * 3;
                                    rgb[off] = r;
                                    rgb[off + 1] = g;
                                    rgb[off + 2] = b;
                                }
                            }
                            uplink_terminal::video::publish_camera_frame(
                                w,
                                h,
                                std::sync::Arc::new(rgb),
                            );
                            i += 1;
                            std::thread::sleep(std::time::Duration::from_millis(40));
                        }
                    });
            }
            let probe = {
                let deadline = Instant::now() + std::time::Duration::from_secs(secs);
                let path = out.clone();
                std::thread::spawn(move || {
                    loop {
                        if Instant::now() >= deadline {
                            break;
                        }
                        let n = video::PEER_FRAMES_TOTAL.load(Ordering::SeqCst);
                        if let Ok(mut f) = std::fs::OpenOptions::new()
                            .create(true)
                            .append(true)
                            .open(&path)
                        {
                            use std::io::Write;
                            let _ = writeln!(
                                f,
                                "{{\"t\":{},\"frames\":{}}}",
                                std::time::SystemTime::now()
                                    .duration_since(std::time::UNIX_EPOCH)
                                    .map(|d| d.as_millis())
                                    .unwrap_or(0),
                                n
                            );
                        }
                        std::thread::sleep(std::time::Duration::from_millis(500));
                    }
                    // Probe deadline reached: unblock join_room's exit spin.
                    uplink_terminal::RUNNING.store(false, Ordering::SeqCst);
                })
            };
            if let Some(at) = toggle_cam_at {
                let _t = std::thread::Builder::new()
                    .name("cam-toggle".into())
                    .spawn(move || {
                        std::thread::sleep(std::time::Duration::from_secs(at));
                        let on = !uplink_terminal::ui::camera_on();
                        uplink_terminal::ui::set_camera_on(on);
                        uplink_terminal::video::overlay_log("🔁 TEST: camera toggled OFF");
                        std::thread::sleep(std::time::Duration::from_secs(6));
                        let on = !uplink_terminal::ui::camera_on();
                        uplink_terminal::ui::set_camera_on(on);
                        uplink_terminal::video::overlay_log("🔁 TEST: camera toggled back ON");
                    });
            }
            let res = signal::join_room(&server, &code, &name, None);
            if let Err(e) = &res {
                eprintln!("JOIN_ERROR: {e:#}");
            }
            let _ = probe.join();
            let total = video::PEER_FRAMES_TOTAL.load(Ordering::SeqCst);
            eprintln!("PROBE_RESULT decoded_frames={total} joined={}", res.is_ok());
            std::process::exit((total & 0xFFFF) as i32);
        }
        Some(Command::Join {
            code,
            name,
            server,
            no_camera,
            fake_cam,
        }) => {
            let name = name.as_deref().unwrap_or("Guest");
            let mut opts = opts;
            opts.fake_cam = fake_cam;
            signal::join_room(&server, &code, name, (!no_camera).then_some(opts))?;
        }
        Some(Command::New {
            name,
            server,
            no_camera,
            fake_cam,
        }) => {
            let name = name.as_deref().unwrap_or("Host");
            let mut opts = opts;
            opts.fake_cam = fake_cam;
            signal::create_and_join(&server, name, (!no_camera).then_some(opts))?;
        }
    }
    Ok(())
}