pub mod api;
mod workspace_rc;
mod conpty;
#[cfg(windows)]
mod conpty_handshake;
mod crashlog;
mod cwd;
pub mod debuglog;
mod dev_tools;
mod editor;
mod error;
mod focus;
mod harness;
mod acp;
mod acp_supervisor;
#[cfg(feature = "headless-e2e")]
pub mod headless;
mod hosts;
mod live;
mod mcp;
mod digest;
mod mcp_cards;
mod mcp_settings;
mod inbox;
mod session_view;
mod butler;
mod models;
mod notify;
mod paste;
mod paths;
mod queue;
mod remote;
mod settings;
mod speech;
mod ssh;
mod terminal;
mod terminal_theme;
mod transcript;
#[cfg(target_os = "windows")]
mod tray;
mod winproc;

use api::{build_state, start_server};
use std::sync::Mutex;
use tauri::Manager;

struct ApiPort(Mutex<u16>);

#[tauri::command]
fn api_base(port: tauri::State<ApiPort>) -> String {
    format!("http://127.0.0.1:{}", *port.0.lock().unwrap())
}

#[tauri::command]
fn open_devtools(window: tauri::WebviewWindow) {
    window.open_devtools();
}

/// Reveal the file in Finder/Explorer and open it in the default editor.
#[tauri::command]
fn reveal_log(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let path = std::path::PathBuf::from(path);
    if !path.exists() {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        if path.extension().is_some() {
            std::fs::write(&path, "").map_err(|e| e.to_string())?;
        } else if !path.exists() {
            return Err("log file not found".into());
        }
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&path)
            .status()
            .map_err(|e| e.to_string())?;
        std::process::Command::new("open")
            .arg(&path)
            .status()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(target_os = "windows")]
    {
        use tauri_plugin_opener::OpenerExt;
        app.opener()
            .reveal_item_in_dir(&path)
            .map_err(|e| e.to_string())?;
        app.opener()
            .open_path(path.to_string_lossy(), None::<&str>)
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .status()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    crate::crashlog::install(crate::paths::logs_dir());
    crate::debuglog::init();
    crate::debuglog::info(
        "app",
        &format!(
        "process-start pid={} version={} arch={} debug={} panic_strategy={} exe={:?} log_time=UTC",
        std::process::id(), env!("CARGO_PKG_VERSION"), std::env::consts::ARCH,
        cfg!(debug_assertions), if cfg!(panic = "abort") { "abort" } else { "unwind" },
        std::env::current_exe().ok(),
    ),
    );
    #[cfg(target_os = "linux")]
    if std::env::var_os("APPDIR").is_some() {
        // AppImage hook forces X11; use native Wayland when available,
        // with X11 retained as fallback.
        std::env::set_var("GDK_BACKEND", "wayland,x11");
    }

    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default();

    #[cfg(not(debug_assertions))]
    {
        // Must be the first plugin registered: a second launch hands its argv to the
        // running instance and exits, instead of spawning a rival process that would
        // race on ~/.que/queue.json, settings.json and the terminal registry.
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            crate::debuglog::info("app", "second-instance activation received");
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }));
    }

    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            #[cfg(windows)]
            tauri::async_runtime::spawn(async {
                if let Err(error) = crate::harness::local_environment(false).await {
                    crate::debuglog::log_error("preload shell environment", &error);
                }
            });
            #[cfg(target_os = "windows")]
            tray::init(app.handle())?;
            crate::debuglog::info(
                "app",
                &format!(
                    "que {} {} log={} level={}",
                    env!("CARGO_PKG_VERSION"),
                    std::env::consts::OS,
                    crate::debuglog::log_path().display(),
                    crate::debuglog::min_level()
                        .map(|l| l.as_str())
                        .unwrap_or("off")
                ),
            );
            let resource_dir = app.path().resource_dir().ok();
            // Prefer the bundled modern ConPTY over the inbox kernel32 build
            // (must happen before the first local pty spawn).
            crate::conpty::preload(resource_dir.as_deref());
            let state = build_state(resource_dir);
            app.manage(state.terminals.clone());
            app.manage(state.clone());
            let port =
                tauri::async_runtime::block_on(start_server(state)).map_err(|e| e.to_string())?;
            app.manage(ApiPort(Mutex::new(port)));
            notify::init(&app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            api_base,
            editor::open_in_vscode,
            open_devtools,
            reveal_log,
            notify::send_completion_notification,
            notify::open_notification_settings,
            notify::request_notification_permission,
            notify::check_notification_permission,
            focus::focus_external_window,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                crate::debuglog::info(
                    "app",
                    &format!(
                        "window-close-requested label={} pid={}",
                        window.label(),
                        std::process::id()
                    ),
                );
                if window.label() == "main" {
                    if let Err(error) = window.hide() {
                        crate::debuglog::warn(
                            "app",
                            &format!("could not hide main window: {error}"),
                        );
                    }
                    api.prevent_close();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Que")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { code, .. } = &event {
                crate::debuglog::info(
                    "app",
                    &format!("exit-requested pid={} code={code:?}", std::process::id()),
                );
            }
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen {
                has_visible_windows,
                ..
            } = event
            {
                if !has_visible_windows {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.unminimize();
                        let _ = window.set_focus();
                    }
                }
            }
            if matches!(event, tauri::RunEvent::Exit) {
                crate::debuglog::info(
                    "app",
                    &format!(
                        "event-loop-exit pid={} terminal-shutdown=begin",
                        std::process::id()
                    ),
                );
                if let Some(hub) = app.try_state::<crate::terminal::TerminalHub>() {
                    hub.shutdown();
                }
                if let Some(state) = app.try_state::<crate::api::AppState>() {
                    let harness = state.harness.clone();
                    tauri::async_runtime::block_on(harness.shutdown());
                    crate::debuglog::info("app", "acp-shutdown=complete");
                }
                crate::debuglog::info(
                    "app",
                    &format!("terminal-shutdown=complete pid={}", std::process::id()),
                );
            }
        });
    crate::debuglog::info("app", &format!("run-returned pid={}", std::process::id()));
}
