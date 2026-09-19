use tauri::AppHandle;

/// Event emitted to the frontend when the user clicks a notification
/// (macOS only). Payload: `{ cardId: string | null, sessionUrl: string }`.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const RESPONSE_EVENT: &str = "que://notification-response";

// user-notify is only used on macOS: it is the only desktop backend that
// delivers click callbacks. On Windows its `Show()` can silently no-op for
// unpackaged dev binaries (no start-menu shortcut for our AUMID), so there
// the tauri notification plugin is used instead — it registers a PowerShell
// shortcut in dev and works for installed apps.
#[cfg(target_os = "macos")]
mod native {
    use std::collections::HashMap;
    use std::sync::{Arc, OnceLock};

    use serde_json::json;
    use tauri::{AppHandle, Emitter, Manager};
    use user_notify::{
        get_notification_manager, NotificationBuilder, NotificationManager,
        NotificationResponseAction,
    };

    static MANAGER: OnceLock<Arc<dyn NotificationManager>> = OnceLock::new();

    pub fn init(app: &AppHandle) {
        let manager = get_notification_manager(app.config().identifier.to_string(), None);
        let emitter = app.clone();
        let registered = manager.register(
            Box::new(move |response| {
                // Only the notification body click routes; dismissals and
                // action buttons (none registered today) are ignored.
                if !matches!(response.action, NotificationResponseAction::Default) {
                    return;
                }
                let Some(session_url) = response.user_info.get("sessionUrl") else {
                    return;
                };
                let payload = json!({
                    "cardId": response.user_info.get("cardId"),
                    "sessionUrl": session_url,
                });
                if let Some(window) = emitter.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
                let _ = emitter.emit(super::RESPONSE_EVENT, payload);
            }),
            Vec::new(),
        );
        if let Err(err) = registered {
            crate::debuglog::warn("notify", &format!("response registration failed: {err:?}"));
        }
        let mgr = manager.clone();
        let _ = MANAGER.set(manager);

        // Explicitly request notification authorization on macOS.
        // On macOS UNUserNotificationCenter, calling this will prompt the user
        // on the first run; subsequent calls return the user's decision without re-prompting.
        tauri::async_runtime::spawn(async move {
            match mgr.first_time_ask_for_notification_permission().await {
                Ok(granted) => {
                    crate::debuglog::info(
                        "notify",
                        &format!("authorization requested: granted={granted}"),
                    );
                }
                Err(err) => {
                    crate::debuglog::warn(
                        "notify",
                        &format!("authorization request error: {err:?}"),
                    );
                }
            }
        });
    }

    pub async fn request_permission() -> Result<bool, String> {
        let Some(manager) = MANAGER.get() else {
            return Err("notification manager unavailable".into());
        };
        manager
            .first_time_ask_for_notification_permission()
            .await
            .map_err(|e| format!("{e:?}"))
    }

    pub async fn check_permission() -> Result<bool, String> {
        let Some(manager) = MANAGER.get() else {
            return Err("notification manager unavailable".into());
        };
        manager
            .get_notification_permission_state()
            .await
            .map_err(|e| format!("{e:?}"))
    }

    pub async fn send(
        title: &str,
        body: &str,
        card_id: &str,
        session_url: &str,
    ) -> Result<(), String> {
        let Some(manager) = MANAGER.get() else {
            return Err("notification manager unavailable".into());
        };
        // Ensure authorization has been requested at least once before sending
        match manager.get_notification_permission_state().await {
            Ok(true) => {}
            Ok(false) => {
                crate::debuglog::info_card(
                    "notify",
                    card_id,
                    None,
                    "permission not yet granted, requesting authorization",
                );
                let _ = manager.first_time_ask_for_notification_permission().await;
            }
            Err(err) => {
                crate::debuglog::warn_card(
                    "notify",
                    card_id,
                    None,
                    &format!("failed reading permission state: {err:?}"),
                );
            }
        }
        let mut user_info = HashMap::new();
        user_info.insert("cardId".to_string(), card_id.to_string());
        user_info.insert("sessionUrl".to_string(), session_url.to_string());
        let builder = NotificationBuilder::new()
            .title(title)
            .body(body)
            .set_user_info(user_info);
        manager
            .send_notification(builder)
            .await
            .map(|_| ())
            .map_err(|e| format!("{e:?}"))
    }
}

/// Initialize the platform notification manager and the click handler.
///
/// Must run during app setup (macOS installs the UNUserNotificationCenter
/// delegate here; the click callback is delivered through it).
pub fn init(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    native::init(app);
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/// Open the OS notification settings page. Runs on the Rust side because the
/// opener plugin's frontend scope only allows web schemes (mailto/tel/http),
/// which rejects `ms-settings:` and `x-apple.systempreferences:`.
#[tauri::command]
pub fn open_notification_settings(app: AppHandle) -> Result<(), String> {
    let url = if cfg!(target_os = "macos") {
        "x-apple.systempreferences:com.apple.Notifications-Settings.extension"
    } else if cfg!(windows) {
        "ms-settings:notifications"
    } else {
        return Err("opening notification settings is not supported on this platform".into());
    };
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(url, None::<&str>)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Send a completion toast with routing metadata. The frontend listens for
/// `RESPONSE_EVENT` and navigates to `session_url` when the toast is clicked.
#[tauri::command]
pub async fn send_completion_notification(
    app: AppHandle,
    title: String,
    body: String,
    card_id: String,
    session_url: String,
) -> Result<(), String> {
    crate::debuglog::debug_card("notify", &card_id, None, "requested");

    #[cfg(target_os = "macos")]
    match native::send(&title, &body, &card_id, &session_url).await {
        Ok(()) => {
            crate::debuglog::info_card("notify", &card_id, None, "sent native");
            return Ok(());
        }
        Err(err) => {
            crate::debuglog::warn_card(
                "notify",
                &card_id,
                None,
                &format!("native failed, fallback: {err}"),
            );
        }
    }

    #[cfg(not(target_os = "macos"))]
    let _ = (&card_id, &session_url);

    // Fallback and Windows/Linux path: the tauri notification plugin, which
    // handles the dev-mode PowerShell shortcut and installed-app AUMID.
    use tauri_plugin_notification::NotificationExt;
    app.notification()
        .builder()
        .title(&title)
        .body(&body)
        .show()
        .map(|_| ())
        .map_err(|e| {
            crate::debuglog::warn_card("notify", &card_id, None, &format!("plugin failed: {e}"));
            e.to_string()
        })?;
    crate::debuglog::info_card("notify", &card_id, None, "sent plugin");
    Ok(())
}

/// Explicitly request notification permission from the OS.
#[tauri::command]
pub async fn request_notification_permission() -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    return native::request_permission().await;
    #[cfg(not(target_os = "macos"))]
    Ok(true)
}

/// Check whether the OS has granted notification permission.
#[tauri::command]
pub async fn check_notification_permission() -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    return native::check_permission().await;
    #[cfg(not(target_os = "macos"))]
    Ok(true)
}
