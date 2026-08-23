//! Overlay window management and cursor position broadcasting.
//!
//! The overlay is a transparent, fullscreen, click-through window that
//! renders characters following the cursor. Characters on the overlay
//! are those with `attention: true` + `on_overlay: true`.
//!
//! Cursor position is broadcast via Tauri events at ~30fps so the
//! frontend can animate character positions smoothly.

use log::info;
use tauri::{webview::WebviewWindowBuilder, AppHandle, Emitter, Manager, WebviewUrl};
use std::thread;
use std::time::Duration;

/// Start cursor position broadcasting (background thread, ~30fps).
/// DEPRECATED: cursor is now polled by overlay frontend via HTTP /cursor endpoint.
#[allow(dead_code)]
pub fn start_cursor_broadcast(app: AppHandle) {
    thread::spawn(move || {
        info!("[overlay] cursor broadcast started (30fps)");
        loop {
            let (x, y) = get_cursor_position();
            let _ = app.emit("nagents:cursor", serde_json::json!({"x": x, "y": y}));
            thread::sleep(Duration::from_millis(33));
        }
    });
}

/// Create (or show) the transparent overlay window.
#[tauri::command]
pub fn create_overlay(app: AppHandle) -> Result<(), String> {
    if let Some(overlay) = app.get_webview_window("overlay") {
        overlay.show().map_err(|e| e.to_string())?;
        return Ok(());
    }

    // Use App URL — Tauri injects IPC bridge properly
    let url = WebviewUrl::App("overlay.html".into());

    let overlay = WebviewWindowBuilder::new(&app, "overlay", url)
        .title("")
        .transparent(true)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .maximized(true)
        .visible_on_all_workspaces(true)
        .build()
        .map_err(|e| e.to_string())?;

    overlay
        .set_ignore_cursor_events(true)
        .map_err(|e| e.to_string())?;
    overlay.show().map_err(|e| e.to_string())?;

    info!("[overlay] window created");
    Ok(())
}

/// Hide the overlay window.
#[tauri::command]
pub fn hide_overlay(app: AppHandle) -> Result<(), String> {
    if let Some(overlay) = app.get_webview_window("overlay") {
        overlay.hide().map_err(|e| e.to_string())?;
        info!("[overlay] window hidden");
    }
    Ok(())
}

/// Toggle click-through on overlay (called by frontend on char hover).
#[tauri::command]
pub fn set_overlay_clickthrough(app: AppHandle, ignore: bool) -> Result<(), String> {
    if let Some(overlay) = app.get_webview_window("overlay") {
        overlay
            .set_ignore_cursor_events(ignore)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Create (or show) the battery saver box window (small, always-on-top, interactive).
#[tauri::command]
pub fn show_bsb_window(app: AppHandle) -> Result<(), String> {
    if let Some(bsb) = app.get_webview_window("bsb") {
        bsb.show().map_err(|e| e.to_string())?;
        return Ok(());
    }

    let url = WebviewUrl::App("bsb.html".into());

    let bsb = WebviewWindowBuilder::new(&app, "bsb", url)
        .title("")
        .transparent(true)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .inner_size(360.0, 130.0)
        .visible_on_all_workspaces(true)
        .build()
        .map_err(|e| e.to_string())?;

    bsb.show().map_err(|e| e.to_string())?;
    info!("[bsb] window created");
    Ok(())
}

/// Hide the battery saver box window.
#[tauri::command]
pub fn hide_bsb_window(app: AppHandle) -> Result<(), String> {
    if let Some(bsb) = app.get_webview_window("bsb") {
        bsb.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Get global cursor position (platform-specific).
pub fn get_cursor_position() -> (f64, f64) {
    crate::cursor::get_cursor_position()
}
