pub mod audio;
pub mod h264;
pub mod kitty;
pub mod render;
pub mod rtc;
pub mod signal;
pub mod ui;
pub mod sixel;
pub mod video;

use std::sync::atomic::{AtomicBool, Ordering};

/// Global run flag: Ctrl+C clears it; the video loop and signaling session
/// share it so a single SIGINT tears everything down.
pub static RUNNING: AtomicBool = AtomicBool::new(true);

pub fn install_ctrlc() {
    ctrlc::set_handler(|| {
        RUNNING.store(false, Ordering::SeqCst);
    })
    .expect("ctrlc handler");

    // Persist panics to disk: any crash (and the current backtrace) lands in
    // /tmp/uplink-panic.log — no more lost evidence when the process drops.
    std::panic::set_hook(Box::new(|info| {
        use std::io::Write;
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let msg = info.payload().downcast_ref::<&str>().map(|s| *s)
            .or_else(|| info.payload().downcast_ref::<String>().map(|s| s.as_str()))
            .unwrap_or("unknown panic");
        let loc = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "unknown location".to_string());
        let bt = std::backtrace::Backtrace::force_capture().to_string();
        let line = format!(
            "\n=== panic t={stamp} at {loc} ===\n{msg}\n{bt}\n"
        );
        let _ = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open("/tmp/uplink-panic.log")
            .and_then(|mut f| f.write_all(line.as_bytes()));
        let _ = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open("/tmp/uplink-panic.log")
            .and_then(|mut f| f.write_all(b"\n"));
    }));
}