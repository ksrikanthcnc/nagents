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
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Command;
use std::thread;
use std::time::Duration;

/// Base tick interval (seconds) for the consolidated scanner loop.
/// Every tick we check which sources are due (per their interval_sec) and run them.
/// 5s base keeps fast (hook-backed) CLI scanners responsive while still
/// collapsing all sources into a single coordinator thread.
const BASE_TICK_SEC: u64 = 5;

/// Start the scanner orchestrator — a SINGLE coordinator thread.
///
/// Instead of one thread per source, one loop ticks every `BASE_TICK_SEC` and
/// spawns each enabled scanner when its own `interval_sec` has elapsed. Config
/// is re-read each tick, so enabling/disabling sources or changing intervals
/// hot-reloads without a restart.
///
/// `project_root` is used as CWD when spawning scanner commands.
pub fn start(store: SessionStore, config: ConfigHandle, project_root: PathBuf) {
    thread::spawn(move || {
        info!(
            "[scanner] consolidated loop started (base tick {}s, cwd={:?})",
            BASE_TICK_SEC, project_root
        );

        // Per-source epoch (seconds) of last run. Missing = never run → run now.
        let mut last_run: HashMap<String, u64> = HashMap::new();

        // Initial scan of all enabled sources immediately at startup.
        run_due_scanners(&store, &config, &project_root, &mut last_run, true);

        loop {
            thread::sleep(Duration::from_secs(BASE_TICK_SEC));
            run_due_scanners(&store, &config, &project_root, &mut last_run, false);
        }
    });
}

/// One tick: for each enabled source with a scanner command, run it if its
/// interval has elapsed (or `force` on the initial pass). Each scanner runs on
/// its own short-lived worker thread so a slow scanner can't block the others.
fn run_due_scanners(
    store: &SessionStore,
    config: &ConfigHandle,
    project_root: &PathBuf,
    last_run: &mut HashMap<String, u64>,
    force: bool,
) {
    let cfg = config.get();
    let now = crate::state::now_epoch() as u64;

    // Drop bookkeeping for sources that no longer exist / are disabled.
    last_run.retain(|id, _| {
        cfg.sources
            .get(id)
            .map(|s| s.enabled && s.scanner.is_some())
            .unwrap_or(false)
    });

    let mut handles = Vec::new();

    for (source_id, source_cfg) in &cfg.sources {
        if !source_cfg.enabled {
            continue;
        }
        let scanner_cmd = match &source_cfg.scanner {
            Some(cmd) => cmd.clone(),
            None => {
                debug!("[scanner] {} has no scanner command, hook-only", source_id);
                continue;
            }
        };

        let interval = source_cfg.interval_sec.max(1);
        let due = force
            || match last_run.get(source_id) {
                Some(&last) => now.saturating_sub(last) >= interval,
                None => true,
            };
        if !due {
            continue;
        }
        last_run.insert(source_id.clone(), now);

        let store = store.clone();
        let source_id = source_id.clone();
        let root = project_root.clone();
        let first = force;

        handles.push(thread::spawn(move || {
            match run_scanner(&scanner_cmd, &source_id, &root) {
                Ok(sessions) => {
                    let count = sessions.len();
                    store.push_sessions(sessions);
                    if first {
                        info!("[scanner] {} initial scan: {} sessions", source_id, count);
                    } else {
                        debug!("[scanner] {} → {} sessions", source_id, count);
                    }
                }
                Err(e) => {
                    warn!("[scanner] {} error: {}", source_id, e);
                }
            }
        }));
    }

    // Wait for this tick's scanners so slow ones don't overlap the next tick's
    // run of the same source (bounded by BASE_TICK_SEC scheduling).
    for h in handles {
        let _ = h.join();
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
