use std::process::Command;

/// Bring an existing external window whose title matches `project` to the foreground (L1: matching window only).
#[tauri::command]
pub async fn focus_external_window(
    kind: String,
    project: Option<String>,
    cwd: Option<String>,
) -> Result<bool, String> {
    let target = project.filter(|s| !s.trim().is_empty()).or_else(|| {
        cwd.as_deref().and_then(|p| {
            let trimmed = p.trim();
            if trimmed.is_empty() {
                None
            } else {
                std::path::Path::new(trimmed)
                    .file_name()
                    .and_then(|n| n.to_str())
                    .map(|s| s.to_string())
            }
        })
    });

    let target_ref = target.as_deref().filter(|s| !s.trim().is_empty());

    crate::debuglog::info(
        "focus",
        &format!("requesting L1 window focus: kind={kind}, target={target_ref:?}"),
    );

    #[cfg(target_os = "macos")]
    {
        return focus_window_macos(&kind, target_ref);
    }
    #[cfg(target_os = "windows")]
    {
        return focus_window_windows(&kind, target_ref);
    }
    #[cfg(target_os = "linux")]
    {
        return focus_window_linux(&kind, target_ref);
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    Ok(false)
}

#[cfg(target_os = "macos")]
mod macos_cocoa {
    use std::ffi::{c_char, c_void, CStr};

    extern "C" {
        fn objc_getClass(name: *const c_char) -> *mut c_void;
        fn sel_registerName(name: *const c_char) -> *mut c_void;
        fn objc_msgSend();
    }

    type MsgSend0 = unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void;
    type MsgSend1Ulong = unsafe extern "C" fn(*mut c_void, *mut c_void, usize) -> *mut c_void;
    type MsgSendActivate = unsafe extern "C" fn(*mut c_void, *mut c_void, usize) -> bool;

    pub fn activate_running_app(bundle_ids: &[&str], app_names: &[&str]) -> bool {
        unsafe {
            let cls_ws = objc_getClass(b"NSWorkspace\0".as_ptr() as _);
            if cls_ws.is_null() {
                return false;
            }
            let sel_shared = sel_registerName(b"sharedWorkspace\0".as_ptr() as _);
            let sel_running = sel_registerName(b"runningApplications\0".as_ptr() as _);
            let sel_count = sel_registerName(b"count\0".as_ptr() as _);
            let sel_obj_at = sel_registerName(b"objectAtIndex:\0".as_ptr() as _);
            let sel_bid = sel_registerName(b"bundleIdentifier\0".as_ptr() as _);
            let sel_name = sel_registerName(b"localizedName\0".as_ptr() as _);
            let sel_utf8 = sel_registerName(b"UTF8String\0".as_ptr() as _);
            let sel_activate = sel_registerName(b"activateWithOptions:\0".as_ptr() as _);

            let msg_ptr = objc_msgSend as *const ();
            let msg0: MsgSend0 = std::mem::transmute(msg_ptr);
            let msg1: MsgSend1Ulong = std::mem::transmute(msg_ptr);
            let msg_act: MsgSendActivate = std::mem::transmute(msg_ptr);

            let ws = msg0(cls_ws, sel_shared);
            if ws.is_null() {
                return false;
            }
            let apps = msg0(ws, sel_running);
            if apps.is_null() {
                return false;
            }
            let count = msg0(apps, sel_count) as usize;

            for i in 0..count {
                let app = msg1(apps, sel_obj_at, i);
                if app.is_null() {
                    continue;
                }
                let bid_ns = msg0(app, sel_bid);
                let name_ns = msg0(app, sel_name);

                let mut matched = false;
                let mut matched_bid: Option<String> = None;
                if !bid_ns.is_null() {
                    let utf8 = msg0(bid_ns, sel_utf8) as *const c_char;
                    if !utf8.is_null() {
                        let cur_bid = CStr::from_ptr(utf8).to_string_lossy();
                        for bid in bundle_ids {
                            if cur_bid.eq_ignore_ascii_case(bid) {
                                matched = true;
                                matched_bid = Some(cur_bid.into_owned());
                                break;
                            }
                        }
                    }
                }
                if !matched && !name_ns.is_null() {
                    let utf8 = msg0(name_ns, sel_utf8) as *const c_char;
                    if !utf8.is_null() {
                        let cur_name = CStr::from_ptr(utf8).to_string_lossy();
                        for name in app_names {
                            if cur_name.eq_ignore_ascii_case(name) {
                                matched = true;
                                break;
                            }
                        }
                    }
                }

                if matched {
                    // NSApplicationActivateAllWindows (1) | NSApplicationActivateIgnoringOtherApps (2) = 3
                    let activated = msg_act(app, sel_activate, 3);
                    if !activated {
                        if let Some(ref bid) = matched_bid {
                            let _ = std::process::Command::new("open")
                                .arg("-b")
                                .arg(bid)
                                .status();
                        }
                    }
                    return true;
                }
            }
            false
        }
    }
}

#[cfg(target_os = "macos")]
fn focus_window_macos(kind: &str, target: Option<&str>) -> Result<bool, String> {
    let (bundle_ids, app_names): (Vec<&str>, Vec<&str>) = match kind {
        "antigravity" => (vec!["com.google.antigravity"], vec!["Antigravity"]),
        "cursor" => (vec!["com.todesktop.230313mzl4w4u92"], vec!["Cursor"]),
        "codebuddy" => (
            vec!["com.tencent.codebuddycn", "com.tencent.codebuddy"],
            vec!["CodeBuddy CN", "CodeBuddy"],
        ),
        "codex" => (
            vec![
                "com.openai.codex",
                "com.todesktop.230313mzl4w4u92",
                "com.microsoft.VSCode",
            ],
            vec!["ChatGPT", "Cursor", "Code", "Terminal", "iTerm2"],
        ),
        "claude" => (
            vec![
                "com.googlecode.iterm2",
                "com.apple.Terminal",
                "com.todesktop.230313mzl4w4u92",
            ],
            vec![
                "iTerm2",
                "Terminal",
                "Ghostty",
                "Alacritty",
                "Cursor",
                "Code",
            ],
        ),
        _ => (
            vec![
                "com.google.antigravity",
                "com.todesktop.230313mzl4w4u92",
                "com.tencent.codebuddycn",
                "com.openai.codex",
                "com.microsoft.VSCode",
            ],
            vec![
                "Antigravity",
                "Cursor",
                "CodeBuddy CN",
                "ChatGPT",
                "Code",
                "Terminal",
                "iTerm2",
            ],
        ),
    };

    let target_str = target.unwrap_or("");

    // 1. AppleScript: unminimize via direct app commands, Dock items, and System Events window attributes
    for app in &app_names {
        let script = format!(
            r#"
            try
                tell application "{app}"
                    activate
                    try
                        set miniaturized of windows to false
                    end try
                    reopen
                end tell
            end try
            try
                tell application "System Events"
                    -- Unminimize from Dock if minimized as a dock icon
                    try
                        tell process "Dock"
                            set minList to (every UI element of list 1 whose role description is "minimized window dock item")
                            repeat with dItem in minList
                                set dName to (name of dItem) as string
                                if "{target_str}" is not "" and dName contains "{target_str}" then
                                    click dItem
                                    return "ok"
                                else if dName contains "{app}" then
                                    click dItem
                                    return "ok"
                                end if
                            end repeat
                        end tell
                    end try

                    -- Unminimize from process windows
                    set pList to (every process whose name is "{app}")
                    if (count of pList) > 0 then
                        tell item 1 of pList
                            try
                                set minWins to (every window whose value of attribute "AXMinimized" is true)
                                repeat with w in minWins
                                    set value of attribute "AXMinimized" of w to false
                                    perform action "AXRaise" of w
                                end repeat
                            end try
                            try
                                set miniaturized of every window to false
                            end try

                            if "{target_str}" is not "" then
                                set wList to (every window whose name contains "{target_str}")
                                if (count of wList) > 0 then
                                    set value of attribute "AXMinimized" of (item 1 of wList) to false
                                    perform action "AXRaise" of (item 1 of wList)
                                end if
                            end if
                            set frontmost to true
                            return "ok"
                        end tell
                    end if
                end tell
            end try
            return "not_found"
            "#
        );

        if let Ok(output) = Command::new("osascript").arg("-e").arg(&script).output() {
            let result = String::from_utf8_lossy(&output.stdout);
            if result.trim() == "ok" {
                crate::debuglog::info(
                    "focus",
                    &format!(
                        "unminimized & raised window via AppleScript app={app} target={target_str}"
                    ),
                );
                let _ = macos_cocoa::activate_running_app(&bundle_ids, &app_names);
                return Ok(true);
            }
        }
    }

    // 2. Direct Cocoa activation with activateWithOptions: 3
    if macos_cocoa::activate_running_app(&bundle_ids, &app_names) {
        crate::debuglog::info(
            "focus",
            &format!("activated running app via Cocoa: kind={kind} target={target_str}"),
        );
        return Ok(true);
    }

    Ok(false)
}

#[cfg(target_os = "windows")]
fn focus_window_windows(kind: &str, target: Option<&str>) -> Result<bool, String> {
    let proc_candidates = match kind {
        "antigravity" => vec!["Antigravity", "antigravity"],
        "cursor" => vec!["cursor", "Cursor"],
        "codebuddy" => vec!["CodeBuddy", "codebuddy"],
        "codex" => vec![
            "ChatGPT",
            "cursor",
            "Code",
            "WindowsTerminal",
            "cmd",
            "powershell",
        ],
        "claude" => vec!["WindowsTerminal", "cmd", "powershell", "cursor", "Code"],
        _ => vec![
            "Antigravity",
            "antigravity",
            "cursor",
            "CodeBuddy",
            "ChatGPT",
            "Code",
            "WindowsTerminal",
        ],
    };

    let procs_joined = proc_candidates
        .iter()
        .map(|p| format!("\"{p}\""))
        .collect::<Vec<_>>()
        .join(",");
    let script = format!(
        r#"$names = @({procs_joined});
$target = [string]$env:QUE_FOCUS_TARGET;
foreach ($n in $names) {{
    $procs = Get-Process -Name $n -ErrorAction SilentlyContinue;
    if ($target -ne "") {{
        $p = $procs | Where-Object {{ $_.MainWindowTitle.IndexOf($target, [StringComparison]::OrdinalIgnoreCase) -ge 0 }} | Select-Object -First 1;
        if ($p -and $p.MainWindowHandle) {{
            (New-Object -ComObject WScript.Shell).AppActivate($p.Id);
            exit 0;
        }}
    }}
    $p = $procs | Where-Object {{ $_.MainWindowHandle -ne 0 }} | Select-Object -First 1;
    if ($p) {{
        (New-Object -ComObject WScript.Shell).AppActivate($p.Id);
        exit 0;
    }}
}}
exit 1"#
    );

    // Project names are data, never PowerShell source (quotes, $(), wildcards).
    // Resolve the OS executable rather than searching a workspace-controlled PATH.
    use crate::winproc::NoWindow;
    let powershell = std::path::PathBuf::from(
        std::env::var_os("SystemRoot").ok_or("SystemRoot is not set")?,
    )
    .join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let output = Command::new(powershell)
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .env("QUE_FOCUS_TARGET", target.unwrap_or(""))
        .no_window()
        .output()
        .map_err(|e| e.to_string())?;

    Ok(output.status.success())
}

#[cfg(target_os = "linux")]
fn focus_window_linux(kind: &str, target: Option<&str>) -> Result<bool, String> {
    if let Some(t) = target {
        if let Ok(status) = Command::new("wmctrl").args(["-a", t]).status() {
            if status.success() {
                return Ok(true);
            }
        }
        if let Ok(status) = Command::new("xdotool")
            .args(["search", "--name", t, "windowactivate"])
            .status()
        {
            if status.success() {
                return Ok(true);
            }
        }
    }
    let app_candidates = match kind {
        "antigravity" => vec!["antigravity", "Antigravity"],
        "cursor" => vec!["cursor", "Cursor"],
        "codebuddy" => vec!["codebuddy", "CodeBuddy"],
        "codex" => vec!["chatgpt", "cursor", "code"],
        "claude" => vec!["terminal", "iterm", "cursor", "code"],
        _ => vec!["antigravity", "cursor", "codebuddy", "code"],
    };
    for app in app_candidates {
        if let Ok(status) = Command::new("wmctrl").args(["-x", "-a", app]).status() {
            if status.success() {
                return Ok(true);
            }
        }
        if let Ok(status) = Command::new("xdotool")
            .args(["search", "--class", app, "windowactivate"])
            .status()
        {
            if status.success() {
                return Ok(true);
            }
        }
    }
    Ok(false)
}
