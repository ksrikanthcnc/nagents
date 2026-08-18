//! Configuration loading and hot-reload.
//!
//! Reads config.yaml from project root, watches for changes, and provides
//! current config to all modules via shared Arc<Mutex<Config>>.

use log::{info, warn};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;

/// Top-level config (mirrors config.yaml).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    #[serde(default)]
    pub sources: HashMap<String, SourceConfig>,
    #[serde(default)]
    pub attention_rules: AttentionRules,
    #[serde(default)]
    pub panel_order: Vec<String>,
    #[serde(default)]
    pub characters: HashMap<String, String>,
    #[serde(default = "default_http_port")]
    pub http_port: u16,
    #[serde(default = "default_log_level")]
    pub log_level: String,
}

/// Per-source configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceConfig {
    /// Command to run for periodic scanning (any language).
    pub scanner: Option<String>,
    /// Scan interval in seconds.
    #[serde(default = "default_interval")]
    pub interval_sec: u64,
    /// Whether this source also accepts hook pushes via HTTP.
    #[serde(default)]
    pub hook: bool,
    /// Whether source is enabled.
    #[serde(default = "default_true")]
    pub enabled: bool,
}

/// Core attention rules (hybrid: source can override).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttentionRules {
    /// Active session with no activity for N seconds → attention.
    #[serde(default = "default_idle_threshold")]
    pub idle_threshold_sec: u64,
    /// Tool event older than N seconds → "approval" (probably waiting).
    #[serde(default = "default_tool_stuck")]
    pub tool_stuck_sec: u64,
    /// Running event older than N seconds → "stuck".
    #[serde(default = "default_running_stuck")]
    pub running_stuck_sec: u64,
    /// Statuses that always trigger attention.
    #[serde(default = "default_waiting_statuses")]
    pub waiting_statuses: Vec<String>,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            sources: HashMap::new(),
            attention_rules: AttentionRules::default(),
            panel_order: vec![
                "on-screen".into(),
                "kiro-cli".into(),
                "crew".into(),
                "kiro-ide".into(),
            ],
            characters: HashMap::new(),
            http_port: default_http_port(),
            log_level: default_log_level(),
        }
    }
}

impl Default for AttentionRules {
    fn default() -> Self {
        AttentionRules {
            idle_threshold_sec: 30,
            tool_stuck_sec: 30,
            running_stuck_sec: 120,
            waiting_statuses: default_waiting_statuses(),
        }
    }
}

fn default_interval() -> u64 {
    5
}
fn default_true() -> bool {
    true
}
fn default_http_port() -> u16 {
    3334
}
fn default_log_level() -> String {
    "info".into()
}
fn default_idle_threshold() -> u64 {
    30
}
fn default_tool_stuck() -> u64 {
    30
}
fn default_running_stuck() -> u64 {
    120
}
fn default_waiting_statuses() -> Vec<String> {
    vec![
        "waiting_on_user".into(),
        "waiting_for_approval".into(),
        "idle".into(),
    ]
}

/// Shared config handle.
#[derive(Clone)]
pub struct ConfigHandle {
    inner: Arc<Mutex<Config>>,
    path: PathBuf,
}

impl ConfigHandle {
    /// Load config from path. Returns default if file doesn't exist.
    pub fn load(path: &Path) -> Self {
        let config = read_config(path);
        info!("[config] loaded from {:?}", path);
        Self {
            inner: Arc::new(Mutex::new(config)),
            path: path.to_path_buf(),
        }
    }

    /// Get current config snapshot.
    pub fn get(&self) -> Config {
        self.inner.lock().unwrap().clone()
    }

    /// Start watching for changes (spawns background thread).
    pub fn watch(&self) {
        let inner = self.inner.clone();
        let path = self.path.clone();

        thread::spawn(move || {
            let (tx, rx) = std::sync::mpsc::channel::<notify::Result<Event>>();

            let mut watcher = match RecommendedWatcher::new(tx, notify::Config::default()) {
                Ok(w) => w,
                Err(e) => {
                    warn!("[config] watcher failed to start: {}", e);
                    return;
                }
            };

            let watch_path = path.parent().unwrap_or(Path::new("."));
            if let Err(e) = watcher.watch(watch_path, RecursiveMode::NonRecursive) {
                warn!("[config] watch error: {}", e);
                return;
            }

            info!("[config] watching {:?} for changes", path);

            for event in rx.into_iter().flatten() {
                if matches!(event.kind, EventKind::Modify(_) | EventKind::Create(_)) {
                    if event.paths.iter().any(|p| p == &path) {
                        let new_config = read_config(&path);
                        let mut cfg = inner.lock().unwrap();
                        *cfg = new_config;
                        info!("[config] hot-reloaded");
                    }
                }
            }
        });
    }
}

fn read_config(path: &Path) -> Config {
    match fs::read_to_string(path) {
        Ok(content) => match serde_yaml::from_str(&content) {
            Ok(c) => c,
            Err(e) => {
                warn!("[config] parse error: {} — using defaults", e);
                Config::default()
            }
        },
        Err(_) => {
            info!("[config] file not found, using defaults");
            Config::default()
        }
    }
}
