//! Scanner orchestrator.
//!
//! For each source configured in config.yaml, spawns the scanner command periodically
//! and parses JSON stdout into sessions. Language-agnostic: any executable that outputs
//! JSON array of sessions to stdout works.
//!
//! Source executables just need to:
//!   1. Discover sessions (however they want — read files, check processes, call APIs)
//!   2. Print a JSON array to stdout matching the Session schema
//!   3. Exit 0

use crate::config::ConfigHandle;
use crate::state::{Session, SessionStore};
use log::{debug, error, info, warn};
use std::path::PathBuf;
use std::process::Command;
use std::thread;
use std::time::Duration;

/// Start the scanner orchestrator (background thread per source).
/// `project_root` is used as CWD when spawning scanner commands.
pub fn start(store: SessionStore, config: ConfigHandle, project_root: PathBuf) {
    let cfg = config.get();

    for (source_id, source_cfg) in &cfg.sources {
        if !source_cfg.enabled {
            info!("[scanner] {} disabled, skipping", source_id);
            continue;
        }

        let scanner_cmd = match &source_cfg.scanner {
            Some(cmd) => cmd.clone(),
            None => {
                debug!("[scanner] {} has no scanner command, hook-only", source_id);
                continue;
            }
        };

        let interval = Duration::from_secs(source_cfg.interval_sec);
        let store = store.clone();
        let source_id = source_id.clone();
        let root = project_root.clone();

        thread::spawn(move || {
            info!(
                "[scanner] {} started (every {}s, cwd={:?}): {}",
                source_id,
                interval.as_secs(),
                root,
                scanner_cmd
            );

            // Scan immediately at startup
            match run_scanner(&scanner_cmd, &source_id, &root) {
                Ok(sessions) => {
                    let count = sessions.len();
                    store.push_sessions(sessions);
                    info!("[scanner] {} initial scan: {} sessions", source_id, count);
                }
                Err(e) => {
                    warn!("[scanner] {} initial scan error: {}", source_id, e);
                }
            }

            // Then periodically
            loop {
                thread::sleep(interval);
                match run_scanner(&scanner_cmd, &source_id, &root) {
                    Ok(sessions) => {
                        let count = sessions.len();
                        store.push_sessions(sessions);
                        debug!("[scanner] {} → {} sessions", source_id, count);
                    }
                    Err(e) => {
                        warn!("[scanner] {} error: {}", source_id, e);
                    }
                }
            }
        });
    }
}

/// Run a scanner command and parse JSON output.
pub fn run_scanner(cmd: &str, source_id: &str, cwd: &PathBuf) -> Result<Vec<Session>, String> {
    let output = Command::new("sh")
        .args(["-c", cmd])
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("failed to spawn: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "exit {}: {}",
            output.status.code().unwrap_or(-1),
            stderr.trim()
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    if stdout.trim().is_empty() {
        return Ok(vec![]);
    }

    let sessions: Vec<Session> =
        serde_json::from_str(&stdout).map_err(|e| format!("JSON parse error: {} (got: {})", e, &stdout[..stdout.len().min(200)]))?;

    // Validate source field matches
    for s in &sessions {
        if s.source != source_id {
            error!(
                "[scanner] {} output session with mismatched source '{}' (id: {})",
                source_id, s.source, s.id
            );
        }
    }

    Ok(sessions)
}
