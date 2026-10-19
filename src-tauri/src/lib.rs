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
mod harness;
mod acp;
mod acp_supervisor;
#[cfg(feature = "headless-e2e")]
pub mod headless;
mod hosts;
mod live;
mod mcp;
mod mcp_cards;
mod mcp_settings;
mod channels;
mod inbox;
mod session_view;
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

struct ApiAccess { port: Mutex<u16>, token: std::sync::Arc<str> }

// Channels change only from the main window: the local HTTP API is not
// authenticated, and an Agent must not open its own channels.
fn main_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() == "main" { Ok(()) } else { Err("Use the main QueACP window".into()) }
}
#[tauri::command]
async fn channel_requests(state: tauri::State<'_, api::AppState>, window: tauri::WebviewWindow) -> Result<serde_json::Value, String> {
    main_window(&window)?;
    channels::requests(&state).await.map_err(|e| e.to_string())
}
#[tauri::command]
async fn channel_decide(state: tauri::State<'_, api::AppState>, window: tauri::WebviewWindow, from: String, to: String, allow: bool) -> Result<(), String> {
    main_window(&window)?;
    channels::decide(&state, &from, &to, allow).await.map_err(|e| e.to_string())
}
#[tauri::command]
async fn channel_set(state: tauri::State<'_, api::AppState>, window: tauri::WebviewWindow, a: String, b: String, joined: bool) -> Result<(), String> {
    main_window(&window)?;
    channels::set(&state, &a, &b, joined).await.map_err(|e| e.to_string())
}
#[tauri::command]
async fn card_permissions_set(state: tauri::State<'_, api::AppState>, window: tauri::WebviewWindow, id: String, permissions: models::CardPermissions) -> Result<(), String> {
    main_window(&window)?;
    channels::set_permissions(&state, &id, permissions).await.map_err(|e| e.to_string())
}
#[tauri::command]
async fn create_requests(state: tauri::State<'_, api::AppState>, window: tauri::WebviewWindow) -> Result<serde_json::Value, String> {
    main_window(&window)?;
    mcp_cards::requests(&state).await.map_err(|e| e.to_string())
}
#[tauri::command]
async fn create_decide(state: tauri::State<'_, api::AppState>, window: tauri::WebviewWindow, id: String, allow: bool) -> Result<(), String> {
    main_window(&window)?;
    mcp_cards::decide(&state, &id, allow).await.map_err(|e| e.to_string())
}

/// The API's address and the token every request must carry; only Que's own windows can ask.
#[tauri::command]
fn api_access(access: tauri::State<ApiAccess>) -> serde_json::Value {
    serde_json::json!({ "base": format!("http://127.0.0.1:{}", *access.port.lock().unwrap()), "token": &*access.token })
}

#[tauri::command]
fn open_devtools(window: tauri::WebviewWindow) {
    window.open_devtools();
}

/// Reveal the file in Finder/Explorer and open it in the default editor.
#[tauri::command]
#[cfg_attr(not(target_os = "windows"), allow(unused_variables))]
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
        std::process::id(), concat!(env!("CARGO_PKG_VERSION"), "+", env!("QUE_COMMIT")), std::env::consts::ARCH,
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
                    concat!(env!("CARGO_PKG_VERSION"), "+", env!("QUE_COMMIT")),
                    std::env::consts::OS,
                    crate::debuglog::log_path().display(),
                    crate::debuglog::min_level()
                        .map(|l| l.as_str())
                        .unwrap_or("off")
                ),
            );
            // On a Force Touch trackpad macOS asks WebKit for a Look Up hit test at
            // every press, the title bar included when dragging the window. WebKit
            // then searches the page's text a character at a time from that point,
            // which across long conversations freezes the page for seconds. Que has
            // no use for Look Up or link previews; turning link previews off also
            // removes that gesture.
            #[cfg(target_os = "macos")]
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.with_webview(|webview| unsafe {
                    let view: &objc2_web_kit::WKWebView = &*webview.inner().cast();
                    view.setAllowsLinkPreview(false);
                });
            }
            let resource_dir = app.path().resource_dir().ok();
            // Prefer the bundled modern ConPTY over the inbox kernel32 build
            // (must happen before the first local pty spawn).
            crate::conpty::preload(resource_dir.as_deref());
            let state = build_state(resource_dir);
            app.manage(state.terminals.clone());
            app.manage(state.clone());
            let token = state.api_token.clone();
            let port =
                tauri::async_runtime::block_on(start_server(state)).map_err(|e| e.to_string())?;
            app.manage(ApiAccess { port: Mutex::new(port), token });
            notify::init(&app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            api_access,
            channel_requests,
            card_permissions_set,
            create_requests,
            create_decide,
            channel_decide,
            channel_set,
            editor::open_in_vscode,
            open_devtools,
            reveal_log,
            notify::send_completion_notification,
            notify::open_notification_settings,
            notify::request_notification_permission,
            notify::check_notification_permission,
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
