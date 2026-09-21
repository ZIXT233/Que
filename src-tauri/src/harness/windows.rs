use regex::Regex;

/// Older releases dropped a shared `que-hook.exe` (plus its ambient aliases and
/// `.sink` markers) under the plugin directories. Hooks now run through Node
/// like on every other platform, so these are inert files — sweep them while a
/// still-running copy simply refuses deletion and is retried next launch.
#[cfg(windows)]
pub(super) fn sweep_legacy_hooks(plugins: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(plugins) else {
        return;
    };
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let Ok(files) = std::fs::read_dir(&dir) else {
            continue;
        };
        for file in files.flatten() {
            let name = file.file_name();
            let Some(name) = name.to_str() else { continue };
            if name.ends_with(".exe")
                || name.ends_with(".sink")
                || name.ends_with(".old")
                || name.ends_with(".tmp")
            {
                let _ = std::fs::remove_file(file.path());
            }
        }
    }
    // Grok's launcher lived beside its hook file, not under harness-plugins.
    if let Some(home) = crate::paths::user_home() {
        let hooks = home.join(".grok/hooks");
        for name in ["que-session-state.exe", "que-session-state.sink"] {
            let _ = std::fs::remove_file(hooks.join(name));
        }
    }
}

pub struct WindowsLaunch {
    pub executable: String,
    pub args: Vec<String>,
}

pub fn windows_command(file: &str, args: &[String]) -> WindowsLaunch {
    if !Regex::new(r"(?i)\.(cmd|bat)$").unwrap().is_match(file) {
        return WindowsLaunch {
            executable: file.to_string(),
            args: args.to_vec(),
        };
    }
    // Node/cross-spawn wraps `cmd /d /s /c "…"` and sets windowsVerbatimArguments so the
    // quotes stay literal. portable-pty always CreateProcess-quotes each argv, which turns
    // that into `\"…\"` and cmd tries to run a path that literally starts with \".
    // Pass path + args as separate tokens after `/c call` instead.
    let comspec = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".into());
    let mut launch = vec![
        "/d".into(),
        "/s".into(),
        "/c".into(),
        "call".into(),
        file.replace('/', "\\"),
    ];
    launch.extend(args.iter().cloned());
    WindowsLaunch {
        executable: comspec,
        args: launch,
    }
}

/// Safe bare tokens avoid a helper process on the common path. Other paths
/// travel inside an encoded PowerShell script, never through cmd expansion.
/// Keep the exact Node executable and inherit stdin/cwd; do not generate shims.
pub fn windows_hook_command(node: &str, hook: &str, event: Option<&str>) -> String {
    // Resolve the executable's native alias once when installing hooks, not by
    // spawning a shell on every event. A bare path works in both cmd and Cursor's
    // PowerShell runner. Keep the hook path intact for registration ownership.
    let short_node = short_executable_path(node);
    let tokens: Vec<&str> = [
        Some(short_node.as_deref().unwrap_or(node)),
        Some(hook),
        event,
    ]
    .into_iter()
    .flatten()
    .collect();
    if tokens.iter().all(|token| safe_bare_token(token)) {
        return tokens
            .iter()
            .map(|token| token.replace('\\', "/"))
            .collect::<Vec<_>>()
            .join(" ");
    }
    let tokens: Vec<&str> = [Some(node), Some(hook), event]
        .into_iter()
        .flatten()
        .collect();
    let quote = |s: &str| format!("'{}'", s.replace('\'', "''"));
    let script = format!("$ErrorActionPreference='Stop'; [Console]::InputEncoding=[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); & {}; exit $LASTEXITCODE", tokens.iter().map(|t| quote(t)).collect::<Vec<_>>().join(" "));
    let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    let encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, bytes);
    format!("powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand {encoded}")
}

#[cfg(windows)]
pub(super) fn short_executable_path(node: &str) -> Option<String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetShortPathNameW;
    if safe_bare_token(node) {
        return None;
    }
    let wide: Vec<u16> = std::ffi::OsStr::new(node)
        .encode_wide()
        .chain(Some(0))
        .collect();
    let size = unsafe { GetShortPathNameW(wide.as_ptr(), std::ptr::null_mut(), 0) };
    if size == 0 {
        return None;
    }
    let mut output = vec![0u16; size as usize];
    let len = unsafe { GetShortPathNameW(wide.as_ptr(), output.as_mut_ptr(), size) };
    if len == 0 || len >= size {
        return None;
    }
    let path = String::from_utf16(&output[..len as usize]).ok()?;
    safe_bare_token(&path).then_some(path)
}

#[cfg(not(windows))]
pub(super) fn short_executable_path(_node: &str) -> Option<String> {
    None
}

fn safe_bare_token(token: &str) -> bool {
    !token.is_empty()
        && token
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || ":/\\._-~".contains(c))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exe_passthrough_and_cmd_launch() {
        let exe = windows_command(
            r"C:\tools\opencode.exe",
            &["--session".into(), "abc".into()],
        );
        assert_eq!(exe.executable, r"C:\tools\opencode.exe");
        assert_eq!(exe.args, vec!["--session", "abc"]);
        assert_eq!(
            windows_command(r"C:\tools\codex.cmd", &[]).args,
            vec!["/d", "/s", "/c", "call", r"C:\tools\codex.cmd"]
        );
    }

    #[test]
    fn ordinary_hook_has_no_helper_process() {
        assert_eq!(
            windows_hook_command(r"C:\Tools\node.exe", r"C:\Que\hook.cjs", Some("Stop")),
            "C:/Tools/node.exe C:/Que/hook.cjs Stop"
        );
        assert_eq!(
            windows_hook_command(
                r"C:\PROGRA~1\nodejs\node.exe",
                r"C:\Que\hook.cjs",
                Some("Stop")
            ),
            "C:/PROGRA~1/nodejs/node.exe C:/Que/hook.cjs Stop"
        );
    }

    #[test]
    fn unusual_paths_preserve_exact_node_and_arguments() {
        let command = windows_hook_command(
            r"C:\Program Files\node.exe",
            r"C:\A&B\%TEMP%\中文\it's\hook.cjs",
            Some("Stop"),
        );
        let bytes = base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            command.split_whitespace().last().unwrap(),
        )
        .unwrap();
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|x| u16::from_le_bytes([x[0], x[1]]))
            .collect();
        let script = String::from_utf16(&units).unwrap();
        assert!(script
            .contains(r"& 'C:\Program Files\node.exe' 'C:\A&B\%TEMP%\中文\it''s\hook.cjs' 'Stop'"));
        assert!(!command.contains('&') && !command.contains('%'));
    }

    #[cfg(windows)]
    #[test]
    fn real_cmd_hook_preserves_stdin_cwd_exit_and_special_paths() {
        use crate::winproc::NoWindow;
        use std::io::Write;
        use std::process::{Command, Stdio};
        let node = which::which("node.exe").expect("Node required for hook integration test");
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("space & %QUE_HOOK_TEST% ! (中文) it's");
        std::fs::create_dir(&dir).unwrap();
        let hook = dir.join("hook.cjs");
        std::fs::write(&hook, "let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{console.log(JSON.stringify({stdin:s,cwd:process.cwd(),event:process.argv[2],node:process.execPath}));process.exitCode=17})").unwrap();
        let line = windows_hook_command(
            &node.to_string_lossy(),
            &hook.to_string_lossy(),
            Some("Stop"),
        );
        let mut child = Command::new("cmd.exe")
            .args(["/d", "/s", "/c", &line])
            .env("QUE_HOOK_TEST", "MUST_NOT_EXPAND")
            .current_dir(tmp.path())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .no_window()
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all("{\"text\":\"中文 & % !\"}".as_bytes())
            .unwrap();
        let result = child.wait_with_output().unwrap();
        assert_eq!(
            result.status.code(),
            Some(17),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        let value: serde_json::Value = serde_json::from_slice(&result.stdout).unwrap();
        assert_eq!(value["stdin"], "{\"text\":\"中文 & % !\"}");
        assert_eq!(value["event"], "Stop");
        assert_eq!(
            std::path::Path::new(value["cwd"].as_str().unwrap()),
            tmp.path()
        );
        assert_eq!(std::path::Path::new(value["node"].as_str().unwrap()), node);
    }
}
