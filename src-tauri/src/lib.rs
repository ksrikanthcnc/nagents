//! nagents — Agent attention overlay app.
//!
//! Single Tauri app: Rust backend manages state, scanners, HTTP endpoint, overlay.
//! Frontend renders panel (control center) and overlay (cursor-following characters).

mod attention;
mod backup;
mod config;
mod cursor;
mod hook;
mod logbuf;
mod overlay;
mod power;
mod scanner;
mod server;
mod state;

use config::ConfigHandle;
use log::{info, warn};
use state::{SessionStore, StateSnapshot};
use std::path::PathBuf;
use tauri::Manager;

/// Tauri command: get full state snapshot.
#[tauri::command]
fn get_state(store: tauri::State<'_, SessionStore>) -> StateSnapshot {
    store.snapshot()
}

/// Tauri command: get current effective config (user config + runtime overrides).
#[tauri::command]
fn get_config(config: tauri::State<'_, ConfigHandle>) -> config::Config {
    config.get_effective()
}

/// Tauri command: toggle overlay visibility and push attention sessions to it.
#[tauri::command]
fn toggle_overlay(app: tauri::AppHandle, store: tauri::State<'_, SessionStore>) -> Result<bool, String> {
    // Check if overlay exists and is visible
    let overlay_visible = app.get_webview_window("overlay")
        .map(|w| w.is_visible().unwrap_or(false))
        .unwrap_or(false);

    if overlay_visible {
        overlay::hide_overlay(app)?;
        // Clear on_overlay flags
        store.update_all(|sessions| {
            for s in sessions.values_mut() {
                s.on_overlay = false;
            }
        });
        Ok(false)
    } else {
        overlay::create_overlay(app)?;
        // Mark attention sessions as on_overlay
        store.update_all(|sessions| {
            for s in sessions.values_mut() {
                s.on_overlay = s.attention;
            }
        });
        Ok(true)
    }
}

pub fn run() {
    // Initialize logging (captures to in-memory buffer for /logs API)
    logbuf::init_logger();

    info!("[nagents] starting...");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_nspanel::init())
        .on_window_event(|window, event| {
            // Only exit app when the main panel window is closed
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    // Hide panel instead of quitting — tray menu has Quit
                    api.prevent_close();
                    let _ = window.hide();
                    info!("[nagents] panel hidden (use tray → Show Panel or Quit)");
                }
                // Overlay close → just hide it (don't destroy)
                if window.label() == "overlay" {
                    let _ = window.hide();
                }
            }
        })
        .setup(|app| {
            // macOS: Accessory policy — shows over fullscreen apps, removes Dock icon
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // Tray icon (since Dock icon is hidden)
            use tauri::tray::TrayIconBuilder;
            use tauri::menu::{MenuBuilder, MenuItemBuilder};
            let show = MenuItemBuilder::with_id("show", "Show Panel").build(app)?;
            let settings = MenuItemBuilder::with_id("settings", "Settings").build(app)?;
            let logs = MenuItemBuilder::with_id("logs", "Logs").build(app)?;
            let hide5 = MenuItemBuilder::with_id("hide5", "Hide Overlay 5min").build(app)?;
            let hide60 = MenuItemBuilder::with_id("hide60", "Hide Overlay 1hr").build(app)?;
            let sleep = MenuItemBuilder::with_id("sleep", "Sleep (pause overlay)").build(app)?;
            let wake = MenuItemBuilder::with_id("wake", "Wake (resume overlay)").build(app)?;
            let backup = MenuItemBuilder::with_id("backup", "Back Up State…").build(app)?;
            let restore = MenuItemBuilder::with_id("restore", "Restore State…").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
            let menu = MenuBuilder::new(app).items(&[&show, &settings, &logs, &hide5, &hide60, &sleep, &wake, &backup, &restore, &quit]).build()?;
            let _tray = TrayIconBuilder::new()
                .icon(tauri::image::Image::from_bytes(include_bytes!("../icons/trayTemplate@2x.png")).unwrap())
                .icon_as_template(true)
                .menu(&menu)
                .tooltip("nagents")
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::DoubleClick { .. } = event {
                        // Double-click tray icon → toggle panel
                        if let Some(win) = tray.app_handle().get_webview_window("main") {
                            if win.is_visible().unwrap_or(false) {
                                let _ = win.hide();
                            } else {
                                let _ = win.show();
                                let _ = win.set_focus();
                            }
                        }
                    }
                })
                .on_menu_event(|app, event| {
                    match event.id().as_ref() {
                        "show" => {
                            if let Some(win) = app.get_webview_window("main") {
                                let _ = win.show();
                                let _ = win.set_focus();
                            }
                        }
                        "settings" => {
                            let _ = crate::overlay::show_settings_window(app.clone());
                        }
                        "logs" => {
                            let _ = crate::overlay::show_logs_window(app.clone());
                        }
                        "hide5" => {
                            let until = std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64 + 5 * 60 * 1000;
                            if let Some(cfg) = app.try_state::<crate::config::ConfigHandle>() {
                                cfg.set_runtime("overlay_hidden_until", serde_json::json!(until), Some(app));
                            }
                            info!("[nagents] overlay hidden for 5 minutes");
                        }
                        "hide60" => {
                            let until = std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64 + 60 * 60 * 1000;
                            if let Some(cfg) = app.try_state::<crate::config::ConfigHandle>() {
                                cfg.set_runtime("overlay_hidden_until", serde_json::json!(until), Some(app));
                            }
                            info!("[nagents] overlay hidden for 1 hour");
                        }
                        "sleep" => {
                            // Sleep / DND: pause overlays indefinitely (until Wake).
                            // Scanners keep running (independent threads) — state stays fresh.
                            // Sentinel = year 2100 in ms epoch (effectively "forever").
                            const FOREVER_MS: u64 = 4_102_444_800_000;
                            if let Some(cfg) = app.try_state::<crate::config::ConfigHandle>() {
                                cfg.set_runtime("overlay_hidden_until", serde_json::json!(FOREVER_MS), Some(app));
                            }
                            info!("[nagents] sleep: overlay paused (scanners still running)");
                        }
                        "wake" => {
                            // Wake: resume overlays. Clears the hidden-until override.
                            if let Some(cfg) = app.try_state::<crate::config::ConfigHandle>() {
                                cfg.set_runtime("overlay_hidden_until", serde_json::json!(0), Some(app));
                            }
                            info!("[nagents] wake: overlay resumed");
                        }
                        "backup" => {
                            handle_backup(app);
                        }
                        "restore" => {
                            handle_restore(app);
                        }
                        "quit" => {
                            // Persist state before quitting
                            let project_root = resolve_project_root_from_handle(app);
                            if let Some(store) = app.try_state::<state::SessionStore>() {
                                persist_sessions(&store, &project_root);
                            }
                            write_close_timestamp(&project_root);
                            info!("[nagents] quitting");
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .build(app)?;

            // Resolve config path (project root / config.yaml)
            let config_path = resolve_config_path(app);
            let config = ConfigHandle::load(&config_path);
            config.watch(Some(app.handle().clone()));

            // Create session store
            let store = SessionStore::new();
            store.set_app_handle(app.handle().clone());

            // Set character pools from config (source → pool of char IDs)
            // Config format: "ghost" (single) or will be extended to lists later
            let char_pools: std::collections::HashMap<String, Vec<String>> = config.get().characters.iter()
                .map(|(source, chars_str)| {
                    let pool: Vec<String> = chars_str.split(',').map(|s| s.trim().to_string()).collect();
                    (source.clone(), pool)
                })
                .collect();
            store.set_char_pools(char_pools);

            // Don't preload sessions — scanners are sole source of truth for what exists.
            // Only load user metadata (pinned/muted/title) to apply after scanners discover sessions.
            let project_root = resolve_project_root(app);

            // Restore pinned/muted/title state from data/sessions.json
            // Applied after a delay (scanners need time to discover sessions first)
            let meta = load_session_meta(&project_root);
            let store_for_meta = store.clone();
            std::thread::spawn(move || {
                // Wait for scanners to complete first run
                std::thread::sleep(std::time::Duration::from_secs(3));
                if !meta.is_empty() {
                    let pinned_ids: Vec<String> = meta.iter()
                        .filter(|(_, m)| m.pinned && !m.muted)
                        .map(|(id, _)| id.clone()).collect();
                    let muted_ids: Vec<String> = meta.iter()
                        .filter(|(_, m)| m.muted)
                        .map(|(id, _)| id.clone()).collect();
                    if !pinned_ids.is_empty() { store_for_meta.restore_pinned(&pinned_ids); }
                    if !muted_ids.is_empty() { store_for_meta.restore_muted(&muted_ids); }
                    for (id, m) in &meta {
                        if let Some(title) = &m.title {
                            store_for_meta.set_title(id, title);
                        }
                        if let Some(character) = &m.character {
                            store_for_meta.set_character(id, character);
                        }
                    }
                    info!("[nagents] restored session meta: {} pinned, {} muted, {} titles, {} chars",
                        pinned_ids.len(), muted_ids.len(),
                        meta.values().filter(|m| m.title.is_some()).count(),
                        meta.values().filter(|m| m.character.is_some()).count());
                }
            });

            // Start HTTP server for external hook pushes
            let http_port = config.get().http_port;
            server::start(store.clone(), config.clone(), http_port, project_root.clone(), Some(app.handle().clone()));

            // Start scanner orchestrator (spawns source executables)
            scanner::start(store.clone(), config.clone(), project_root);

            // Start attention computation loop
            attention::start(store.clone(), config.clone());

            // Create overlay window at startup (always exists, shows chars when attention)
            let app_handle = app.handle().clone();
            let config_for_power = config.clone();
            std::thread::spawn(move || {
                // Wait for Vite dev server to be ready
                std::thread::sleep(std::time::Duration::from_secs(5));
                if let Err(e) = overlay::create_overlay(app_handle.clone()) {
                    log::warn!("[nagents] overlay creation failed: {}", e);
                } else {
                    info!("[nagents] overlay window created");
                }
                // Watch for display add/remove → re-span the overlay dynamically.
                overlay::start_display_watch(app_handle.clone());
                // Start power monitoring (detects AC/battery, sets runtime overrides)
                power::start_monitoring(app_handle, config_for_power);
            });

            // Register managed state for Tauri commands
            app.manage(store);
            app.manage(config);

            info!("[nagents] all systems ready");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_state,
            get_config,
            toggle_overlay,
            overlay::create_overlay,
            overlay::hide_overlay,
            overlay::set_overlay_clickthrough,
            overlay::show_bsb_window,
            overlay::hide_bsb_window,
            overlay::show_settings_window,
            overlay::show_logs_window,
            overlay::get_overlay_display_info,
            power::get_power,
        ])
        .run(tauri::generate_context!())
        .expect("error running nagents");
}

/// Find config.yaml relative to the Tauri resource directory or CWD.
fn resolve_config_path(app: &tauri::App) -> PathBuf {
    // In development, config is at project root (one level up from src-tauri)
    if cfg!(debug_assertions) {
        let manifest_dir = env!("CARGO_MANIFEST_DIR");
        let project_root = PathBuf::from(manifest_dir)
            .parent()
            .unwrap_or_else(|| std::path::Path::new("."))
            .to_path_buf();
        return project_root.join("config.yaml");
    }

    // In production: use bundled config from Resources, user data in app_data_dir
    // First-launch: copy bundled config to user data dir
    let data_dir = app.path().app_data_dir().unwrap_or_else(|_| PathBuf::from("."));
    let user_config = data_dir.join("config.yaml");
    if !user_config.exists() {
        let _ = std::fs::create_dir_all(&data_dir);
        // Copy from bundle resources (Tauri puts ../ paths under _up_/)
        if let Ok(resource_dir) = app.path().resource_dir() {
            let bundled = resource_dir.join("_up_").join("config.yaml");
            if bundled.exists() {
                let _ = std::fs::copy(&bundled, &user_config);
                info!("[config] first launch: copied bundled config to {:?}", user_config);
            }
        }
    }
    user_config
}

/// Resolve the project root (where scanners/data live).
/// Dev: project dir. Prod: app data dir (with scanners from bundle resources).
fn resolve_project_root(app: &tauri::App) -> PathBuf {
    resolve_project_root_from_handle(app.handle())
}

/// Same as resolve_project_root but takes AppHandle (for tray menu handlers).
fn resolve_project_root_from_handle(handle: &tauri::AppHandle) -> PathBuf {
    if cfg!(debug_assertions) {
        let manifest_dir = env!("CARGO_MANIFEST_DIR");
        return PathBuf::from(manifest_dir)
            .parent()
            .unwrap_or_else(|| std::path::Path::new("."))
            .to_path_buf();
    }

    // Production: scanners are in bundle resources, data in app_data_dir
    let data_dir = handle.path().app_data_dir().unwrap_or_else(|_| PathBuf::from("."));
    let _ = std::fs::create_dir_all(&data_dir);

    // Copy scanners from bundle to data dir on EVERY launch (overwrite), so a
    // new build's scanners always take effect. Scanners are code, not user data
    // — edit them in the repo and rebuild, not in app-data.
    if let Ok(resource_dir) = handle.path().resource_dir() {
        let bundled_sources = resource_dir.join("_up_").join("sources");
        let user_sources = data_dir.join("sources");
        if bundled_sources.exists() {
            copy_dir_recursive(&bundled_sources, &user_sources);
            info!("[config] refreshed scanners from bundle → {:?}", user_sources);
        }
    }

    data_dir
}

/// Recursively copy a directory.
fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) {
    let _ = std::fs::create_dir_all(dst);
    if let Ok(entries) = std::fs::read_dir(src) {
        for entry in entries.flatten() {
            let path = entry.path();
            let dest = dst.join(entry.file_name());
            if path.is_dir() {
                copy_dir_recursive(&path, &dest);
            } else {
                let _ = std::fs::copy(&path, &dest);
            }
        }
    }
}

/// Tray: back up state to a user-chosen .zip. Persists current state first so
/// the backup is fresh, then opens a native save dialog and zips the data root.
/// Runs the (blocking) dialog on a worker thread to avoid blocking the tray.
fn handle_backup(app: &tauri::AppHandle) {
    use tauri_plugin_dialog::DialogExt;

    let project_root = resolve_project_root_from_handle(app);
    // Flush current in-memory state to disk before snapshotting.
    if let Some(store) = app.try_state::<state::SessionStore>() {
        persist_sessions(&store, &project_root);
    }

    let app = app.clone();
    std::thread::spawn(move || {
        let default_name = backup::default_backup_name();
        let dest = app
            .dialog()
            .file()
            .set_file_name(&default_name)
            .add_filter("Zip archive", &["zip"])
            .blocking_save_file();

        let Some(dest) = dest else {
            info!("[backup] cancelled");
            return;
        };
        let Some(dest_path) = dest.as_path() else {
            warn!("[backup] no path from dialog");
            return;
        };
        match backup::backup_state(&project_root, dest_path) {
            Ok(n) => info!("[backup] saved {} files → {}", n, dest_path.display()),
            Err(e) => warn!("[backup] failed: {}", e),
        }
    });
}

/// Tray: restore state from a user-chosen .zip. Extracts over the data root,
/// then reloads persisted session meta into the live store. Overlay/panel pick
/// up changes via the normal state-changed emit.
fn handle_restore(app: &tauri::AppHandle) {
    use tauri_plugin_dialog::DialogExt;

    let project_root = resolve_project_root_from_handle(app);
    let app = app.clone();
    std::thread::spawn(move || {
        let src = app
            .dialog()
            .file()
            .add_filter("Zip archive", &["zip"])
            .blocking_pick_file();

        let Some(src) = src else {
            info!("[restore] cancelled");
            return;
        };
        let Some(src_path) = src.as_path() else {
            warn!("[restore] no path from dialog");
            return;
        };
        match backup::restore_state(src_path, &project_root) {
            Ok(n) => {
                info!("[restore] restored {} files from {}", n, src_path.display());
                // Reload persisted meta (pinned/muted/title/character) into the
                // live store so the change is visible without a restart.
                if let Some(store) = app.try_state::<state::SessionStore>() {
                    let meta = load_session_meta(&project_root);
                    let pinned_ids: Vec<String> = meta.iter()
                        .filter(|(_, m)| m.pinned && !m.muted).map(|(id, _)| id.clone()).collect();
                    let muted_ids: Vec<String> = meta.iter()
                        .filter(|(_, m)| m.muted).map(|(id, _)| id.clone()).collect();
                    store.restore_pinned(&pinned_ids);
                    store.restore_muted(&muted_ids);
                    for (id, m) in &meta {
                        if let Some(title) = &m.title { store.set_title(id, title); }
                        if let Some(character) = &m.character { store.set_character(id, character); }
                    }
                    info!("[restore] reloaded meta into live store");
                }
            }
            Err(e) => warn!("[restore] failed: {}", e),
        }
    });
}

/// Write app close timestamp and full session state (called on shutdown).
fn write_close_timestamp(project_root: &PathBuf) {
    use std::fs;
    let _ = fs::create_dir_all(project_root.join("data"));
    let close_file = project_root.join("data/app_closed_at");
    let _ = fs::write(&close_file, format!("{}", state::now_epoch()));
}

/// Persist all sessions to data/sessions.json (called on shutdown).
fn persist_sessions(store: &state::SessionStore, project_root: &PathBuf) {
    use std::fs;
    let sessions = store.get_all();
    let path = project_root.join("data/sessions.json");
    match serde_json::to_string_pretty(&sessions) {
        Ok(json) => {
            let _ = fs::write(&path, json);
            info!("[shutdown] persisted {} sessions to data/sessions.json", sessions.len());
        }
        Err(e) => {
            log::warn!("[shutdown] failed to persist sessions: {}", e);
        }
    }
    // Also persist pinned/muted/titles to data/sessions.json
    persist_session_meta(store, project_root);
}

/// Per-session metadata persisted to data/sessions.json.
/// Stores pinned, muted, title, and character overrides in one file.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct SessionMeta {
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub pinned: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub muted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// User-picked character (from panel). Auto-assigned chars are NOT stored
    /// here — they're deterministic from session id. Only explicit picks persist.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub character: Option<String>,
}

const SESSION_META_FILE: &str = "data/sessions.json";

/// Persist session metadata (pinned, muted, titles) to data/sessions.json.
pub fn persist_session_meta(store: &state::SessionStore, project_root: &PathBuf) {
    use std::fs;
    use std::collections::HashMap;

    let sessions = store.get_all();
    let mut meta: HashMap<String, SessionMeta> = HashMap::new();

    for s in &sessions {
        let has_data = s.pinned || s.muted;
        if has_data {
            meta.insert(s.id.clone(), SessionMeta {
                pinned: s.pinned && !s.muted, // exclusivity: muted wins
                muted: s.muted,
                title: None,
                character: None, // preserved via merge from existing file below
            });
        }
    }

    // Merge existing titles + character picks already in sessions.json so we
    // don't lose them (they're not derivable from the live session snapshot).
    let path = project_root.join(SESSION_META_FILE);
    if let Ok(existing_json) = fs::read_to_string(&path) {
        if let Ok(existing) = serde_json::from_str::<HashMap<String, SessionMeta>>(&existing_json) {
            for (id, existing_meta) in existing {
                if let Some(title) = existing_meta.title {
                    meta.entry(id.clone()).or_default().title = Some(title);
                }
                if let Some(character) = existing_meta.character {
                    meta.entry(id).or_default().character = Some(character);
                }
            }
        }
    }

    let _ = fs::create_dir_all(project_root.join("data"));
    if let Ok(json) = serde_json::to_string_pretty(&meta) {
        let _ = fs::write(&path, json + "\n");
    }
}

/// Load session metadata from data/sessions.json.
/// On first run, migrates from legacy pinned.json + titles.json.
pub fn load_session_meta(project_root: &PathBuf) -> std::collections::HashMap<String, SessionMeta> {
    use std::fs;
    use std::collections::HashMap;

    let path = project_root.join(SESSION_META_FILE);

    // If sessions.json exists, use it directly
    if let Ok(json) = fs::read_to_string(&path) {
        if let Ok(meta) = serde_json::from_str::<HashMap<String, SessionMeta>>(&json) {
            return meta;
        }
    }

    // First run: migrate from legacy files
    let mut meta: HashMap<String, SessionMeta> = HashMap::new();

    let pinned_path = project_root.join("data/pinned.json");
    if let Ok(json) = fs::read_to_string(&pinned_path) {
        if let Ok(ids) = serde_json::from_str::<Vec<String>>(&json) {
            for id in ids {
                meta.entry(id).or_default().pinned = true;
            }
        }
        let _ = fs::remove_file(&pinned_path);
        info!("[migrate] migrated pinned.json → sessions.json");
    }

    let titles_path = project_root.join("data/titles.json");
    if let Ok(json) = fs::read_to_string(&titles_path) {
        if let Ok(titles) = serde_json::from_str::<HashMap<String, String>>(&json) {
            for (id, title) in titles {
                meta.entry(id).or_default().title = Some(title);
            }
        }
        let _ = fs::remove_file(&titles_path);
        info!("[migrate] migrated titles.json → sessions.json");
    }

    // Write the merged result
    if !meta.is_empty() {
        let _ = fs::create_dir_all(project_root.join("data"));
        if let Ok(json) = serde_json::to_string_pretty(&meta) {
            let _ = fs::write(&path, json + "\n");
        }
    }

    meta
}

/// Persist a single title update into sessions.json.
pub fn persist_title_to_meta(session_id: &str, title: &str, project_root: &PathBuf) {
    use std::fs;
    use std::collections::HashMap;

    let path = project_root.join(SESSION_META_FILE);
    let _ = fs::create_dir_all(project_root.join("data"));

    let mut meta: HashMap<String, SessionMeta> = if let Ok(json) = fs::read_to_string(&path) {
        serde_json::from_str(&json).unwrap_or_default()
    } else {
        HashMap::new()
    };

    meta.entry(session_id.to_string()).or_default().title = Some(title.to_string());

    if let Ok(json) = serde_json::to_string_pretty(&meta) {
        let _ = fs::write(&path, json + "\n");
    }
}

/// Persist a single user character pick into sessions.json (survives restarts
/// and reinstalls — app-data dir is preserved). Auto-assigned chars are NOT
/// written here; only explicit panel picks call this.
pub fn persist_character_to_meta(session_id: &str, character: &str, project_root: &PathBuf) {
    use std::fs;
    use std::collections::HashMap;

    let path = project_root.join(SESSION_META_FILE);
    let _ = fs::create_dir_all(project_root.join("data"));

    let mut meta: HashMap<String, SessionMeta> = if let Ok(json) = fs::read_to_string(&path) {
        serde_json::from_str(&json).unwrap_or_default()
    } else {
        HashMap::new()
    };

    meta.entry(session_id.to_string()).or_default().character = Some(character.to_string());

    if let Ok(json) = serde_json::to_string_pretty(&meta) {
        let _ = fs::write(&path, json + "\n");
    }
}
