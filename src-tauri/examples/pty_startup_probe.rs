//! Non-graphical startup probe using the same PTY library and ConPTY as Que.
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::io::{Read, Write};
use std::sync::mpsc;
use std::time::{Duration, Instant};
#[path = "../src/conpty_handshake.rs"]
mod conpty_handshake;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        let arch = if std::env::consts::ARCH == "aarch64" {
            "win-arm64"
        } else {
            "win-x64"
        };
        let dll = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources/conpty")
            .join(arch)
            .join("conpty.dll");
        let wide: Vec<u16> = dll.as_os_str().encode_wide().chain(Some(0)).collect();
        #[link(name = "kernel32")]
        extern "system" {
            fn LoadLibraryW(path: *const u16) -> *mut std::ffi::c_void;
        }
        let handle = unsafe { LoadLibraryW(wide.as_ptr()) };
        assert!(!handle.is_null(), "cannot load bundled ConPTY");
    }
    let reply = std::env::args().any(|arg| arg == "--reply");
    let reply_da1 = std::env::args().any(|arg| arg == "--reply-da1");
    let reply_colors = std::env::args().any(|arg| arg == "--reply-colors");
    let observe_theme = std::env::args().any(|arg| arg == "--observe-theme");
    let theme_cycle = std::env::args().any(|arg| arg == "--theme-cycle");
    let mut color_offsets = [0; 2];
    let mut phase = 0;
    let mut phase_starts = vec![0];
    let mut startup_handshake = std::env::args()
        .any(|arg| arg == "--startup-handshake")
        .then(conpty_handshake::StartupHandshake::default);
    let cli: Vec<String> = std::env::args()
        .skip_while(|arg| arg != "--")
        .skip(1)
        .collect();
    let start = Instant::now();
    let pair = native_pty_system().openpty(PtySize {
        rows: 30,
        cols: 100,
        pixel_width: 0,
        pixel_height: 0,
    })?;
    let mut command = CommandBuilder::new(cli.first().map(String::as_str).unwrap_or("cmd.exe"));
    if cli.is_empty() {
        command.args(["/d", "/c", "echo QUE_PTY_READY"]);
    } else {
        command.args(&cli[1..]);
    }
    command.env("TERM", "xterm-256color");
    command.env_remove("NO_COLOR");
    command.env("COLORTERM", "truecolor");
    command.env(
        "COLORFGBG",
        if std::env::args().any(|arg| arg == "--light") {
            "0;15"
        } else {
            "15;0"
        },
    );
    let mut child = pair.slave.spawn_command(command)?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader()?;
    let mut writer = pair.master.take_writer()?;
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 || tx.send(buf[..n].to_vec()).is_err() {
                break;
            }
        }
    });
    let mut output = String::new();
    while start.elapsed() < Duration::from_secs(20) {
        if theme_cycle
            && ((phase == 0 && start.elapsed().as_secs() >= 12)
                || (phase == 1 && start.elapsed().as_secs() >= 16))
        {
            phase += 1;
            phase_starts.push(output.len());
            writer.write_all(if phase == 1 {
                b"\x1b[?997;1n"
            } else {
                b"\x1b[?997;2n"
            })?;
            writer.flush()?;
            println!("THEME_PHASE {phase}");
        }
        let Ok(chunk) = rx.recv_timeout(Duration::from_secs(1)) else {
            continue;
        };
        let text = String::from_utf8_lossy(&chunk);
        if let Some(reply) = startup_handshake.as_mut().and_then(|h| h.feed(&chunk)) {
            writer.write_all(reply)?;
            writer.flush()?;
            println!(
                "{}ms startup handshake answered",
                start.elapsed().as_millis()
            );
        }
        if cli.is_empty() || chunk.len() < 80 {
            println!("{}ms {:?}", start.elapsed().as_millis(), text);
        } else {
            println!(
                "{}ms output_bytes={}",
                start.elapsed().as_millis(),
                chunk.len()
            );
        }
        output.push_str(&text);
        if reply_colors {
            for (i, code) in [10, 11].iter().enumerate() {
                while let Some(offset) = output[color_offsets[i]..].find(&format!("\x1b]{code};?"))
                {
                    color_offsets[i] += offset + format!("\x1b]{code};?").len();
                    let color = if phase == 1 {
                        "0000/2b2b/3636"
                    } else {
                        "fdfd/f6f6/e3e3"
                    };
                    writer.write_all(format!("\x1b]{code};rgb:{color}\x1b\\").as_bytes())?;
                    writer.flush()?;
                    println!("{}ms replied OSC {code}", start.elapsed().as_millis());
                }
            }
        }
        if reply_da1 && output.contains("\x1b[c") {
            writer.write_all(b"\x1b[?1;2c")?;
            writer.flush()?;
            println!("{}ms sent DA1", start.elapsed().as_millis());
            output = output.replace("\x1b[c", "");
        }
        if reply && output.contains("\x1b[6n") {
            writer.write_all(b"\x1b[1;1R")?;
            writer.flush()?;
            println!("{}ms sent CPR", start.elapsed().as_millis());
            output = output.replace("\x1b[6n", "");
        }
        if output.contains("QUE_PTY_READY") {
            println!(
                "READY {}ms cpr={reply} da1={reply_da1}",
                start.elapsed().as_millis()
            );
            break;
        }
        if !observe_theme && !cli.is_empty() && output.len() > 2000 {
            println!(
                "OUTPUT_2KB {}ms cpr={reply} da1={reply_da1}",
                start.elapsed().as_millis()
            );
            break;
        }
    }
    println!(
        "theme_subscription={} osc10_query={} osc11_query={}",
        output.contains("\x1b[?2031h"),
        output.contains("\x1b]10;?"),
        output.contains("\x1b]11;?")
    );
    let mut sgr = std::collections::BTreeSet::new();
    for tail in output.split("\x1b[").skip(1) {
        if let Some(end) = tail.find(|c: char| c.is_ascii_alphabetic()) {
            if tail.as_bytes()[end] == b'm' {
                sgr.insert(&tail[..end]);
            }
        }
    }
    println!("SGR={sgr:?}");
    for (i, begin) in phase_starts.iter().enumerate() {
        let end = phase_starts.get(i + 1).copied().unwrap_or(output.len());
        let mut backgrounds = std::collections::BTreeSet::new();
        for tail in output[*begin..end].split("\x1b[").skip(1) {
            if let Some(end) = tail.find('m') {
                let sequence = &tail[..end];
                if sequence.len() < 80 && sequence.contains("48;") {
                    backgrounds.insert(sequence);
                }
            }
        }
        println!("PHASE_{i}_BACKGROUNDS={backgrounds:?}");
    }
    if let Ok(path) = std::env::var("QUE_PTY_PROBE_OUTPUT") {
        std::fs::write(path, &output)?;
    }
    let _ = child.kill();
    Ok(())
}
