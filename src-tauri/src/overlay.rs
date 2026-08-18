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

/// Get global cursor position (platform-specific).
#[cfg(target_os = "macos")]
pub fn get_cursor_position() -> (f64, f64) {
    use std::ffi::c_void;
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventCreate(source: *const c_void) -> *const c_void;
        fn CGEventGetLocation(event: *const c_void) -> CGPoint;
        fn CFRelease(cf: *const c_void);
    }
    #[repr(C)]
    #[derive(Copy, Clone)]
    struct CGPoint {
        x: f64,
        y: f64,
    }
    unsafe {
        let event = CGEventCreate(std::ptr::null());
        if event.is_null() {
            return (0.0, 0.0);
        }
        let point = CGEventGetLocation(event);
        CFRelease(event);
        (point.x, point.y)
    }
}

#[cfg(target_os = "windows")]
pub fn get_cursor_position() -> (f64, f64) {
    use std::mem::MaybeUninit;
    #[repr(C)]
    struct POINT {
        x: i32,
        y: i32,
    }
    extern "system" {
        fn GetCursorPos(point: *mut POINT) -> i32;
    }
    unsafe {
        let mut point = MaybeUninit::<POINT>::uninit();
        if GetCursorPos(point.as_mut_ptr()) != 0 {
            let p = point.assume_init();
            (p.x as f64, p.y as f64)
        } else {
            (0.0, 0.0)
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn get_cursor_position() -> (f64, f64) {
    // Linux: would need X11/Wayland — placeholder for now
    (0.0, 0.0)
}
