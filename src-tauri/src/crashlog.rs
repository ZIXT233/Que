//! Panic reports bypass the normal logger: it may be disabled or hold its lock.
use std::io::Write;
use std::path::PathBuf;
use std::sync::Once;
use std::time::{SystemTime, UNIX_EPOCH};

pub fn install(directory: PathBuf) {
    static INSTALLED: Once = Once::new();
    INSTALLED.call_once(|| {
        let _ = std::fs::create_dir_all(&directory);
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            let time = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default();
            let pid = std::process::id();
            let thread = std::thread::current();
            let path = directory.join(format!("panic-{pid}-{}.log", time.as_nanos()));
            if let Ok(mut file) = std::fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(path)
            {
                let _ = writeln!(file, "unix_time={} pid={pid} thread={:?} name={:?} panic_strategy={}",
                    time.as_secs(), thread.id(), thread.name(),
                    if cfg!(panic = "abort") { "abort" } else { "unwind" });
                let _ = writeln!(file, "exe={:?}\n{info}", std::env::current_exe().ok());
                // Preserve the location/message even if stack capture itself fails.
                let _ = file.sync_data();
                let _ = writeln!(file, "backtrace:\n{}", std::backtrace::Backtrace::force_capture());
                let _ = file.sync_data();
            }
            // Preserve default stderr behavior and the existing panic strategy.
            previous(info);
        }));
    });
}
