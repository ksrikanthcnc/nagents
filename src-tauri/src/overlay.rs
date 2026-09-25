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
    destroy_all_overlays(&app);

    if cross_screen_enabled(&app) {
        create_per_display_overlays(&app)
    } else {
        create_single_overlay(&app)
    }
}

/// Destroy all overlay windows (the single "overlay" and any per-display "overlay-N").
fn destroy_all_overlays(app: &AppHandle) {
    // Single overlay
    if let Some(w) = app.get_webview_window("overlay") {
        let _ = w.destroy();
    }
    // Per-display overlays
    for i in 0..16 {
        let label = format!("overlay-{}", i);
        if let Some(w) = app.get_webview_window(&label) {
            let _ = w.destroy();
        } else {
            break; // no more
        }
    }
    std::thread::sleep(Duration::from_millis(200));
}

/// Single-display mode: one overlay on the primary monitor (original behavior).
fn create_single_overlay(app: &AppHandle) -> Result<(), String> {
    let url = WebviewUrl::App("overlay.html".into());

    let overlay = WebviewWindowBuilder::new(app, "overlay", url)
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

    overlay.set_ignore_cursor_events(true).map_err(|e| e.to_string())?;
    overlay.set_content_protected(true).map_err(|e| e.to_string())?;

    // Store bounds for /cursor (primary at origin 0,0 matches old behavior)
    if let Some(m) = overlay.primary_monitor().ok().flatten() {
        let s = m.scale_factor();
        let w = m.size().width as f64 / s;
        let h = m.size().height as f64 / s;
        *OVERLAY_BOUNDS.lock().unwrap() = OverlayBounds { x: 0.0, y: 0.0, w, h };
    }

    #[cfg(target_os = "macos")]
    make_overlay_panel(app, "overlay");

    overlay.show().map_err(|e| e.to_string())?;
    info!("[overlay] single-display overlay created");
    Ok(())
}

/// Per-display mode: one overlay window per monitor. Each window loads the same
/// overlay UI but is told (via URL query) which display region it covers, so the
/// frontend maps global cursor → its local space and only renders chars whose
/// virtual position falls on its display. All windows run the same physics
/// against the same global cursor + session state (shared trajectory), so char
/// positions are consistent — no explicit hand-off messaging needed.
fn create_per_display_overlays(app: &AppHandle) -> Result<(), String> {
    let monitors = app.available_monitors().map_err(|e| e.to_string())?;
    if monitors.is_empty() {
        return Err("no monitors found".into());
    }

    let to_logical = |px: f64, scale: f64| if scale > 0.0 { px / scale } else { px };
    let (mut vmin_x, mut vmin_y, mut vmax_x, mut vmax_y) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
    let mut rects = Vec::new();

    for m in &monitors {
        let s = m.scale_factor();
        let lx = to_logical(m.position().x as f64, s);
        let ly = to_logical(m.position().y as f64, s);
        let lw = to_logical(m.size().width as f64, s);
        let lh = to_logical(m.size().height as f64, s);
        vmin_x = vmin_x.min(lx);
        vmin_y = vmin_y.min(ly);
        vmax_x = vmax_x.max(lx + lw);
        vmax_y = vmax_y.max(ly + lh);
        rects.push(DisplayRect { x: lx, y: ly, w: lw, h: lh });
    }
    let vw = (vmax_x - vmin_x).max(1.0);
    let vh = (vmax_y - vmin_y).max(1.0);
    *OVERLAY_BOUNDS.lock().unwrap() = OverlayBounds { x: vmin_x, y: vmin_y, w: vw, h: vh };
    *DISPLAY_RECTS.lock().unwrap() = rects;

    // Simple: each overlay loads the same overlay.html with NO query params.
    // Each window self-discovers its display bounds from its screen position
    // + the /cursor endpoint's display rects. No lead/follower — each window
    // runs its own physics independently with global cursor coords.
    for (i, m) in monitors.iter().enumerate() {
        let s = m.scale_factor();
        let lx = to_logical(m.position().x as f64, s);
        let ly = to_logical(m.position().y as f64, s);
        let lw = to_logical(m.size().width as f64, s);
        let lh = to_logical(m.size().height as f64, s);

        let label = format!("overlay-{}", i);
        let url = WebviewUrl::App("overlay.html".into());

        // Populate the display info map BEFORE building the window. The WKWebView
        // starts loading JS immediately on .build(), and the JS calls
        // get_overlay_display_info via IPC. If the map isn't populated yet, the
        // IPC returns None → the window falls through to independent physics →
        // artifacts. This was the root cause of the multi-monitor artifacts bug.
        {
            let mut map = WINDOW_DISPLAY_MAP.lock().unwrap();
            let rects_clone = DISPLAY_RECTS.lock().unwrap().clone();
            map.insert(label.clone(), WindowDisplayInfo {
                dx: lx, dy: ly, dw: lw, dh: lh,
                vox: vmin_x, voy: vmin_y, vw, vh,
                is_lead: i == 0,
                displays: rects_clone,
            });
        }

        let overlay = WebviewWindowBuilder::new(app, &label, url)
            .title("")
            .transparent(true)
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .visible_on_all_workspaces(true)
            .build()
            .map_err(|e| format!("overlay-{}: {}", i, e))?;

        {
            use tauri::LogicalPosition;
            use tauri::LogicalSize;
            let _ = overlay.set_position(LogicalPosition::new(lx, ly));
            let _ = overlay.set_size(LogicalSize::new(lw, lh));
        }

        overlay.set_ignore_cursor_events(true).map_err(|e| e.to_string())?;
        if !cfg!(debug_assertions) {
            overlay.set_content_protected(true).map_err(|e| e.to_string())?;
        }

        // macOS window exclusion: skip entirely in dev (vite HMR triggers ObjC
        // exceptions when reloading modified windows). Release builds apply it.
        #[cfg(target_os = "macos")]
        if !cfg!(debug_assertions) {
            apply_light_exclusion(app, &label);
        }

        overlay.show().map_err(|e| e.to_string())?;

        info!(
            "[overlay] per-display {} created: ({:.0},{:.0}) {:.0}x{:.0} scale={:.1}",
            label, lx, ly, lw, lh, s
        );
    }

    info!(
        "[overlay] per-display mode: {} overlays, virtual desktop ({:.0},{:.0}) {:.0}x{:.0}",
        monitors.len(), vmin_x, vmin_y, vw, vh
    );
    Ok(())
}

/// The overlay's current logical origin + size on the virtual desktop.
/// The frontend needs the origin to map global cursor points → window-local
/// coords (`local = global - origin`). Written by span_overlay, read by
/// GET /cursor. Logical (point) units, matching CGEventGetLocation + CSS px.
#[derive(Clone, Copy, Debug)]
pub struct OverlayBounds {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// Per-display rect (logical coords). Used by the frontend to determine which
/// display the cursor is on, so roamers can stick to the cursor's display.
#[derive(Clone, Debug, serde::Serialize)]
pub struct DisplayRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

static OVERLAY_BOUNDS: std::sync::Mutex<OverlayBounds> =
    std::sync::Mutex::new(OverlayBounds { x: 0.0, y: 0.0, w: 0.0, h: 0.0 });
static DISPLAY_RECTS: std::sync::Mutex<Vec<DisplayRect>> =
    std::sync::Mutex::new(Vec::new());
/// Per-window label → its display rect + role. Set by create_per_display_overlays,
/// read by the frontend via the get_overlay_display_info Tauri command.
static WINDOW_DISPLAY_MAP: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<String, WindowDisplayInfo>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

/// Display info for a specific overlay window. Returned by Tauri IPC command.
#[derive(Clone, Debug, serde::Serialize)]
pub struct WindowDisplayInfo {
    /// This display's logical bounds in the virtual desktop.
    pub dx: f64,
    pub dy: f64,
    pub dw: f64,
    pub dh: f64,
    /// Virtual desktop origin.
    pub vox: f64,
    pub voy: f64,
    /// Virtual desktop total size.
    pub vw: f64,
    pub vh: f64,
    /// True if this is the primary/lead window (runs physics).
    pub is_lead: bool,
    /// All display rects (for cursor-display detection).
    pub displays: Vec<DisplayRect>,
}

/// Tauri command: get the display info for the calling window.
/// Each overlay window calls this on init to learn which display it covers
/// and whether it's the lead (physics owner) or a follower (renderer).
#[tauri::command]
pub fn get_overlay_display_info(window: tauri::WebviewWindow) -> Option<WindowDisplayInfo> {
    let label = window.label().to_string();
    let map = WINDOW_DISPLAY_MAP.lock().unwrap();
    let result = map.get(&label).cloned();
    info!("[overlay] get_overlay_display_info called by '{}' → {}", label,
        if result.is_some() { "found" } else { "NOT FOUND" });
    result
}

/// Current overlay bounds (logical). Used by the /cursor endpoint.
pub fn overlay_bounds() -> OverlayBounds {
    *OVERLAY_BOUNDS.lock().unwrap()
}

/// Current display rects (logical). Used by the /cursor endpoint.
pub fn display_rects() -> Vec<DisplayRect> {
    DISPLAY_RECTS.lock().unwrap().clone()
}

/// Watch for display add/remove (and layout changes) and re-span the overlay.
/// Tauri has no reliable cross-version monitor-change event, so we poll the
/// monitor layout every few seconds and re-span only when it actually changes.
pub fn start_display_watch(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last_sig = String::new();
        loop {
            std::thread::sleep(Duration::from_secs(3));
            let sig = monitor_signature(&app);
            if sig.is_empty() {
                continue;
            }
            if sig != last_sig {
                if !last_sig.is_empty() {
                    info!("[overlay] display layout changed → recreating overlays");
                    let _ = create_overlay(app.clone());
                }
                last_sig = sig;
            }
        }
    });
}

/// A compact signature of the current monitor layout (count + each monitor's
/// position/size/scale). Changes when a display is added, removed, or moved.
fn monitor_signature(app: &AppHandle) -> String {
    let Ok(monitors) = app.available_monitors() else { return String::new() };
    let mut parts: Vec<String> = monitors
        .iter()
        .map(|m| {
            format!(
                "{},{},{}x{},{:.2}",
                m.position().x, m.position().y, m.size().width, m.size().height, m.scale_factor()
            )
        })
        .collect();
    parts.sort();
    // Fold in the cross-screen setting so toggling multi_screen /
    // attention_cross_screen also triggers a re-span (within one poll cycle).
    parts.push(format!("cross={}", cross_screen_enabled(app)));
    parts.join("|")
}

/// Whether the overlay should cover all displays. True if either the
/// multi_screen (all chars) or attention_cross_screen (attention chars) config
/// is enabled — either needs canvas on every display.
fn cross_screen_enabled(app: &AppHandle) -> bool {
    let Some(cfg) = app.try_state::<crate::config::ConfigHandle>() else { return false };
    let overlay = cfg.get_effective().overlay;
    let get_bool = |key: &str, default: bool| {
        overlay.extra.get(key).map(|v| match v {
            serde_json::Value::Bool(b) => *b,
            serde_json::Value::String(s) => s == "true",
            _ => default,
        }).unwrap_or(default)
    };
    // attention_cross_screen defaults ON; multi_screen defaults OFF.
    get_bool("multi_screen", false) || get_bool("attention_cross_screen", true)
}

/// macOS: convert a window to an NSPanel and apply overlay window traits.
/// Runs on the main thread (AppKit requirement). Uses tauri-nspanel's safe
/// swizzle instead of a raw setClass (which crashes the WKWebView window).
#[cfg(target_os = "macos")]
fn make_overlay_panel(app: &AppHandle, label: &str) {
    use tauri_nspanel::WebviewWindowExt;

    let Some(window) = app.get_webview_window(label) else { return };
    // to_panel() must run on the main thread.
    let _ = window.clone().run_on_main_thread(move || {
        match window.to_panel() {
            Ok(_panel) => {
                // Now that it's an NSPanel, apply utility/non-activating style
                // (→ AXFloatingWindow subrole) + all-Spaces + high level.
                apply_panel_traits(&window);
            }
            Err(e) => log::warn!("[overlay] to_panel failed: {:?}", e),
        }
    });
}

/// NSWindow level for the overlay. Pop-up-menu level (kCGPopUpMenuWindowLevel =
/// 101) sits above normal windows. NSWindowLevel is a plain isize.
#[cfg(target_os = "macos")]
const NS_POPUP_MENU_WINDOW_LEVEL: isize = 101;

/// Light exclusion for follower overlay windows (no NSPanel swizzle — avoids
/// crash risk). Sets collectionBehavior + high level. Won't fully hide from
/// AltTab but avoids the ObjC exception from runtime class-swizzling.
#[cfg(target_os = "macos")]
fn apply_light_exclusion(app: &AppHandle, label: &str) {
    let Some(window) = app.get_webview_window(label) else { return };
    let lbl = label.to_string();
    let w2 = window.clone();
    let _ = w2.run_on_main_thread(move || {
        use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior};

        let Ok(ptr) = window.ns_window() else { return };
        if ptr.is_null() { return; }
        unsafe {
            let ns = &*(ptr as *const NSWindow);
            let behavior = NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::Stationary
                | NSWindowCollectionBehavior::IgnoresCycle
                | NSWindowCollectionBehavior::Transient
                | NSWindowCollectionBehavior::FullScreenAuxiliary;
            ns.setCollectionBehavior(behavior);
            ns.setLevel(NS_POPUP_MENU_WINDOW_LEVEL);
            ns.setHidesOnDeactivate(false);
        }
        log::info!("[overlay] {} light exclusion applied (no panel swizzle)", lbl);
    });
}

/// macOS: apply overlay panel traits. MUST be called on the main thread and
/// AFTER the window has been converted to an NSPanel (see make_overlay_panel).
///
/// The utility + non-activating panel style makes the window report the
/// AXFloatingWindow accessibility subrole, which AltTab's WindowAdmissionResolver
/// rejects as "auxiliary" (verified against its source) — so it's excluded from
/// AltTab. The collectionBehavior handles native Cmd-Tab + all-Spaces, and the
/// raised level keeps it above normal windows. Non-activating means it never
/// steals focus (correct for a click-through overlay).
#[cfg(target_os = "macos")]
fn apply_panel_traits(window: &tauri::WebviewWindow) {
    use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior, NSWindowStyleMask};

    let Ok(ns_window_ptr) = window.ns_window() else {
        log::warn!("[overlay] ns_window() unavailable; cannot apply panel traits");
        return;
    };
    if ns_window_ptr.is_null() {
        return;
    }
    // SAFETY: valid NSPanel pointer (already swizzled), on the main thread.
    unsafe {
        let ns_window = &*(ns_window_ptr as *const NSWindow);

        let mask = NSWindowStyleMask::Borderless
            | NSWindowStyleMask::NonactivatingPanel
            | NSWindowStyleMask::UtilityWindow;
        ns_window.setStyleMask(mask);

        let behavior = NSWindowCollectionBehavior::CanJoinAllSpaces
            | NSWindowCollectionBehavior::Stationary
            | NSWindowCollectionBehavior::IgnoresCycle
            | NSWindowCollectionBehavior::Transient
            | NSWindowCollectionBehavior::FullScreenAuxiliary;
        ns_window.setCollectionBehavior(behavior);

        ns_window.setLevel(NS_POPUP_MENU_WINDOW_LEVEL);
        ns_window.setHidesOnDeactivate(false);
    }
    log::info!("[overlay] applied NSPanel traits (AXFloatingWindow → excluded from switchers)");
}

/// Hide all overlay windows (single or per-display).
#[tauri::command]
pub fn hide_overlay(app: AppHandle) -> Result<(), String> {
    if let Some(overlay) = app.get_webview_window("overlay") {
        overlay.hide().map_err(|e| e.to_string())?;
    }
    for i in 0..16 {
        let label = format!("overlay-{}", i);
        if let Some(w) = app.get_webview_window(&label) {
            let _ = w.hide();
        } else {
            break;
        }
    }
    info!("[overlay] hidden");
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
        .resizable(true)
        .inner_size(600.0, 130.0)
        .visible_on_all_workspaces(true)
        .build()
        .map_err(|e| e.to_string())?;

    #[cfg(target_os = "macos")]
    make_overlay_panel(&app, "bsb");

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

/// Show the settings window (creates if not exists).
#[tauri::command]
pub fn show_settings_window(app: AppHandle) -> Result<(), String> {
    use tauri::WebviewWindowBuilder;
    use tauri::WebviewUrl;

    if let Some(win) = app.get_webview_window("settings") {
        win.show().map_err(|e| e.to_string())?;
        win.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }

    let url = WebviewUrl::App("settings.html".into());

    let win = WebviewWindowBuilder::new(&app, "settings", url)
        .title("nagents — Settings")
        .decorations(true)
        .resizable(true)
        .inner_size(500.0, 600.0)
        .build()
        .map_err(|e| e.to_string())?;

    win.show().map_err(|e| e.to_string())?;
    info!("[settings] window created");
    Ok(())
}

/// Show the logs window (creates if not exists).
#[tauri::command]
pub fn show_logs_window(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("logs") {
        win.show().map_err(|e| e.to_string())?;
        win.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }

    let url = WebviewUrl::App("logs.html".into());

    let win = WebviewWindowBuilder::new(&app, "logs", url)
        .title("nagents — Logs")
        .decorations(true)
        .resizable(true)
        .inner_size(700.0, 500.0)
        .build()
        .map_err(|e| e.to_string())?;

    win.show().map_err(|e| e.to_string())?;
    info!("[logs] window created");
    Ok(())
}
