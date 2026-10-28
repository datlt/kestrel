//! Tauri app entry. This file only wires the features together.
//! Each feature lives in `cmd/<feature>.rs` (Tauri commands) and in a
//! `crates/kestrel-<feature>` crate (logic without Tauri). See docs/DESIGN.md.

mod cmd;

use std::time::Duration;
use tauri::{Manager, RunEvent, WindowEvent};

pub fn run() {
    kestrel_common::process::init_shell_env();

    let handlers = cmd::Handlers::new();
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            // Second guard after the frontend link handlers: a web view may only
            // show app pages and local previews, never a page from the internet.
            tauri::plugin::Builder::<tauri::Wry>::new("kestrel-nav-guard")
                // Web tabs (labels `web-*`, see cmd/web.rs) show real web sites, so
                // they may go anywhere. They have no access to Kestrel commands.
                .on_navigation(|webview, url| webview.label().starts_with("web-") || navigation_allowed(url))
                .build(),
        )
        .plugin(
            tauri_plugin_window_state::Builder::new()
                // The frontend shows the window after the first paint (no white flash).
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all() - tauri_plugin_window_state::StateFlags::VISIBLE,
                )
                .build(),
        );
    let builder = cmd::preview::register_protocol(builder);
    #[cfg(target_os = "macos")]
    let builder = builder.menu(mac_menu);

    let app = builder
        .invoke_handler(move |invoke| handlers.dispatch(invoke))
        .setup(|app| {
            cmd::setup(app)?;
            // If the frontend fails before it shows the window, show it anyway.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(3));
                for (_, w) in handle.webview_windows() {
                    if !w.is_visible().unwrap_or(true) {
                        let _ = w.show();
                    }
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::Destroyed = event {
                cmd::on_window_destroyed(window.app_handle(), window.label());
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build the Kestrel app");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            cmd::on_exit(handle);
        }
    });
}

fn navigation_allowed(url: &tauri::Url) -> bool {
    match url.scheme() {
        "tauri" | "preview" | "about" | "data" | "blob" => true,
        "http" | "https" => match url.host_str() {
            Some("tauri.localhost" | "preview.localhost" | "ipc.localhost") => true,
            // The Vite dev server.
            Some("localhost" | "127.0.0.1") => cfg!(debug_assertions),
            _ => false,
        },
        _ => false,
    }
}

/// macOS app menu. It has no "Close Window" item, so Cmd+W reaches the web
/// view and closes the active tab. The Edit menu keeps copy and paste working
/// in text inputs.
#[cfg(target_os = "macos")]
fn mac_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{Menu, PredefinedMenuItem as P, Submenu};
    let app_menu = Submenu::with_items(
        app,
        "Kestrel",
        true,
        &[
            &P::about(app, None, None)?,
            &P::separator(app)?,
            &P::services(app, None)?,
            &P::separator(app)?,
            &P::hide(app, None)?,
            &P::hide_others(app, None)?,
            &P::show_all(app, None)?,
            &P::separator(app)?,
            &P::quit(app, None)?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &P::undo(app, None)?,
            &P::redo(app, None)?,
            &P::separator(app)?,
            &P::cut(app, None)?,
            &P::copy(app, None)?,
            &P::paste(app, None)?,
            &P::select_all(app, None)?,
        ],
    )?;
    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[&P::minimize(app, None)?, &P::maximize(app, None)?, &P::fullscreen(app, None)?],
    )?;
    Menu::with_items(app, &[&app_menu, &edit, &window])
}
