use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager,
};

fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let result = window
            .unminimize()
            .and_then(|_| window.show())
            .and_then(|_| window.set_focus());
        if let Err(error) = result {
            crate::debuglog::warn("tray", &format!("could not restore main window: {error}"));
        }
    }
}

pub fn init(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(
        app,
        "que.tray.open",
        "打开 Que / Open Que",
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(
        app,
        "que.tray.quit",
        "退出 Que / Quit Que",
        true,
        None::<&str>,
    )?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| std::io::Error::other("Que tray icon is missing"))?;

    // Register before enabling close-to-tray: never leave a hidden application
    // without a way to restore it. Tauri retains the registered tray resource.
    TrayIconBuilder::with_id("que.main")
        .icon(icon)
        .tooltip("Que")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                show_main(tray.app_handle());
            }
        })
        .on_menu_event(|app, event| match event.id.as_ref() {
            "que.tray.open" => show_main(app),
            // Explicit application exit bypasses CloseRequested; the existing
            // RunEvent::Exit handler shuts down the terminal sessions.
            "que.tray.quit" => {
                crate::debuglog::info("app", "exit-source=tray code=0");
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;
    Ok(())
}
