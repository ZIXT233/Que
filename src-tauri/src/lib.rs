pub mod api;
mod conpty;
#[cfg(windows)]
mod conpty_handshake;
mod cwd;
pub mod debuglog;
mod dev_tools;
mod error;
mod focus;
mod harness;
#[cfg(feature = "headless-e2e")]
pub mod headless;
mod hosts;
mod live;
mod models;
mod notify;
mod paste;
mod paths;
mod queue;
mod remote;
mod settings;
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
fn reveal_log(path: String) -> Result<(), String> {
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
        std::process::Command::new("explorer")
            .arg(format!("/select,{}", path.display()))
            .status()
            .map_err(|e| e.to_string())?;
        std::process::Command::new("cmd")
            .args(["/C", "start", "", path.to_str().unwrap_or("")])
            .status()
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
            crate::debuglog::init();
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
            // Hook plugins are only installed when a card of that kind launches, so a
            // build with a new ingress script leaves the kinds this machine no longer
            // launches on the old one — silently, since the provider's config keeps
            // pointing at the same path. Align them here: at most one small write each.
            let aligned =
                crate::harness::sync_installed_hooks(&state.bin_dir, &crate::paths::plugins_dir());
            // Dev and release obey the same saved external-notification settings.
            // An explicit opt-out remains available for isolated development.
            let should_deploy_external = std::env::var("QUE_SKIP_EXTERNAL_HOOKS").is_err();

            if should_deploy_external {
                // Settings-aware: enabled kinds install, disabled ones get their
                // Que entries stripped (the toggle's other half).
                crate::harness::sync_external_hooks(
                    &state.bin_dir,
                    &crate::paths::plugins_dir(),
                    &state.settings.read()?,
                );
            }
            if !aligned.is_empty() {
                crate::debuglog::info(
                    "hooks",
                    &format!("plugin hooks realigned: {}", aligned.join(", ")),
                );
            }
            app.manage(state.terminals.clone());
            let port =
                tauri::async_runtime::block_on(start_server(state)).map_err(|e| e.to_string())?;
            app.manage(ApiPort(Mutex::new(port)));
            notify::init(&app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            api_base,
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
                if window.label() == "main" {
                    #[cfg(any(target_os = "macos", target_os = "windows"))]
                    {
                        if let Err(error) = window.hide() {
                            crate::debuglog::warn(
                                "app",
                                &format!("could not hide main window: {error}"),
                            );
                        }
                    }
                    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
                    {
                        let _ = window.minimize();
                    }
                    api.prevent_close();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Que")
        .run(|app, event| {
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
                if let Some(hub) = app.try_state::<crate::terminal::TerminalHub>() {
                    hub.shutdown();
                }
            }
        });
}
