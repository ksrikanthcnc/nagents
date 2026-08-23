//! nagents — Agent attention overlay app.
//!
//! Single Tauri app: Rust backend manages state, scanners, HTTP endpoint, overlay.
//! Frontend renders panel (control center) and overlay (cursor-following characters).

mod attention;
mod config;
mod cursor;
mod overlay;
mod scanner;
mod server;
mod state;

use config::ConfigHandle;
use log::info;
use state::{SessionStore, StateSnapshot};
use std::path::PathBuf;
use tauri::Manager;

/// Tauri command: get full state snapshot.
#[tauri::command]
fn get_state(store: tauri::State<'_, SessionStore>) -> StateSnapshot {
    store.snapshot()
}

/// Tauri command: get current config.
#[tauri::command]
fn get_config(config: tauri::State<'_, ConfigHandle>) -> config::Config {
    config.get()
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
    // Initialize logging
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .format_timestamp_millis()
        .init();

    info!("[nagents] starting...");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .on_window_event(|window, event| {
            // Only exit app when the main panel window is closed
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                if window.label() == "main" {
                    // Persist session state + close timestamp for restart recovery
                    let manifest_dir = env!("CARGO_MANIFEST_DIR");
                    let project_root = PathBuf::from(manifest_dir)
                        .parent()
                        .unwrap_or_else(|| std::path::Path::new("."))
                        .to_path_buf();
                    // Save full session state
                    if let Some(store) = window.app_handle().try_state::<state::SessionStore>() {
                        persist_sessions(&store, &project_root);
                    }
                    write_close_timestamp(&project_root);
                    info!("[nagents] main window closed, exiting");
                    std::process::exit(0);
                }
                // Overlay close → just hide it (don't destroy)
                if window.label() == "overlay" {
                    let _ = window.hide();
                }
            }
        })
        .setup(|app| {
            // Resolve config path (project root / config.yaml)
            let config_path = resolve_config_path(app);
            let config = ConfigHandle::load(&config_path);
            config.watch();

            // Create session store
            let store = SessionStore::new();

            // Set character pools from config (source → pool of char IDs)
            // Config format: "ghost" (single) or will be extended to lists later
            let char_pools: std::collections::HashMap<String, Vec<String>> = config.get().characters.iter()
                .map(|(source, chars_str)| {
                    let pool: Vec<String> = chars_str.split(',').map(|s| s.trim().to_string()).collect();
                    (source.clone(), pool)
                })
                .collect();
            store.set_char_pools(char_pools);

            // Reload cached events from data/events/ (restore state from last run)
            let project_root = config_path.parent().unwrap_or(std::path::Path::new(".")).to_path_buf();
            reload_event_cache(&store, &project_root);

            // Clear stale attention for non-idle sessions (fixes #022: missed hook clears during downtime)
            store.clear_stale_attention();

            // Start HTTP server for external hook pushes
            let http_port = config.get().http_port;
            server::start(store.clone(), http_port, project_root.clone());

            // Start scanner orchestrator (spawns source executables)
            scanner::start(store.clone(), config.clone(), project_root);

            // Start attention computation loop
            attention::start(store.clone(), config.clone());

            // Create overlay window at startup (always exists, shows chars when attention)
            let app_handle = app.handle().clone();
            std::thread::spawn(move || {
                // Wait for Vite dev server to be ready
                std::thread::sleep(std::time::Duration::from_secs(5));
                if let Err(e) = overlay::create_overlay(app_handle) {
                    log::warn!("[nagents] overlay creation failed: {}", e);
                } else {
                    info!("[nagents] overlay window created");
                }
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

    // In production, look next to the app
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("config.yaml")
}

/// Reload session state from persisted snapshot + event cache.
/// Reads data/sessions.json (full state) first, then overlays recent events from JSONL.
/// Only reloads if downtime < 1 hour.
fn reload_event_cache(store: &state::SessionStore, project_root: &PathBuf) {
    use std::fs;
    use std::io::{BufRead, BufReader};

    // Read app close timestamp (written on shutdown)
    let close_file = project_root.join("data/app_closed_at");
    let closed_at: f64 = fs::read_to_string(&close_file)
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0.0);
    let now = state::now_epoch();
    let downtime = if closed_at > 0.0 { now - closed_at } else { 0.0 };
    info!("[cache] app was closed {}s ago", downtime as u64);

    // Only reload if downtime < 1 hour
    if downtime > 3600.0 {
        info!("[cache] downtime > 1hr, starting fresh");
        let _ = fs::remove_file(&close_file);
        return;
    }

    // Step 1: Load full session snapshot (persisted on last shutdown)
    let sessions_path = project_root.join("data/sessions.json");
    if sessions_path.exists() {
        match fs::read_to_string(&sessions_path) {
            Ok(json) => {
                let sessions: Vec<state::Session> = match serde_json::from_str(&json) {
                    Ok(s) => s,
                    Err(e) => {
                        log::warn!("[cache] failed to parse sessions.json: {}", e);
                        vec![]
                    }
                };
                if !sessions.is_empty() {
                    // Also load titles to apply any saved overrides
                    let titles = load_titles(project_root);
                    let mut enriched = sessions;
                    for session in &mut enriched {
                        if let Some(title) = titles.get(&session.id) {
                            session.name = title.clone();
                        }
                    }
                    store.restore_sessions(enriched);
                }
            }
            Err(e) => {
                log::warn!("[cache] failed to read sessions.json: {}", e);
            }
        }
    }

    // Step 2: Overlay any recent events from JSONL cache (in case hooks fired after last snapshot)
    let events_dir = project_root.join("data/events");
    if !events_dir.exists() {
        info!("[cache] no events dir, skipping event overlay");
        let _ = fs::remove_file(&close_file);
        return;
    }

    let mut loaded = 0;
    let entries = match fs::read_dir(&events_dir) {
        Ok(e) => e,
        Err(_) => {
            let _ = fs::remove_file(&close_file);
            return;
        }
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().map(|e| e != "jsonl").unwrap_or(true) {
            continue;
        }

        // Read last line of the file (most recent event)
        let file = match fs::File::open(&path) {
            Ok(f) => f,
            Err(_) => continue,
        };
        let reader = BufReader::new(file);
        let mut last_line = String::new();
        for line in reader.lines().flatten() {
            if !line.is_empty() {
                last_line = line;
            }
        }

        if last_line.is_empty() {
            continue;
        }

        let update: state::EventUpdate = match serde_json::from_str(&last_line) {
            Ok(u) => u,
            Err(_) => continue,
        };

        let mtime = update.mtime.unwrap_or(0.0);
        if now - mtime > 3600.0 {
            continue; // Event itself is too old
        }

        store.push_event(update);
        loaded += 1;
    }

    info!("[cache] reloaded {} recent events (downtime={}s)", loaded, downtime as u64);

    // Clean up the close timestamp file
    let _ = fs::remove_file(&close_file);
}

/// Load titles from data/titles.json.
fn load_titles(project_root: &PathBuf) -> std::collections::HashMap<String, String> {
    use std::fs;
    let path = project_root.join("data/titles.json");
    if !path.exists() {
        return std::collections::HashMap::new();
    }
    match fs::read_to_string(&path) {
        Ok(json) => serde_json::from_str(&json).unwrap_or_default(),
        Err(_) => std::collections::HashMap::new(),
    }
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
}
