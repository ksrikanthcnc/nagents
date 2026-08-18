//! nagents — Agent attention overlay app.
//!
//! Single Tauri app: Rust backend manages state, scanners, HTTP endpoint, overlay.
//! Frontend renders panel (control center) and overlay (cursor-following characters).

mod attention;
mod config;
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

pub fn run() {
    // Initialize logging
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .format_timestamp_millis()
        .init();

    info!("[nagents] starting...");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // Resolve config path (project root / config.yaml)
            let config_path = resolve_config_path(app);
            let config = ConfigHandle::load(&config_path);
            config.watch();

            // Create session store
            let store = SessionStore::new();

            // Start HTTP server for external hook pushes
            let http_port = config.get().http_port;
            server::start(store.clone(), http_port);

            // Start scanner orchestrator (spawns source executables)
            scanner::start(store.clone(), config.clone());

            // Start attention computation loop
            attention::start(store.clone(), config.clone());

            // Start cursor broadcast for overlay
            overlay::start_cursor_broadcast(app.handle().clone());

            // Register managed state for Tauri commands
            app.manage(store);
            app.manage(config);

            info!("[nagents] all systems ready");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_state,
            get_config,
            overlay::create_overlay,
            overlay::hide_overlay,
            overlay::set_overlay_clickthrough,
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
