//! Hybrid attention computation.
//!
//! Runs periodically (every 5s) and updates `attention` + `attention_reason` on each session.
//!
//! Priority:
//!   1. Source explicitly set attention_source → use that
//!   2. Otherwise, apply core rules from config (stuck detector, waiting statuses, idle threshold)
//!
//! Also manages `attention_since` timestamps for recency tracking.

use crate::config::ConfigHandle;
use crate::state::{now_epoch, SessionStore};
use log::{debug, info};
use std::thread;
use std::time::Duration;

/// Start the attention computation loop (background thread).
pub fn start(store: SessionStore, config: ConfigHandle) {
    thread::spawn(move || {
        info!("[attention] started (checking every 5s)");
        loop {
            thread::sleep(Duration::from_secs(5));
            compute(&store, &config);
        }
    });
}

fn compute(store: &SessionStore, config: &ConfigHandle) {
    let rules = config.get().attention_rules;
    let now = now_epoch();

    store.update_all(|sessions| {
        for session in sessions.values_mut() {
            let prev_attention = session.attention;

            // Priority 1: source explicitly set it
            if let Some(source_attention) = session.attention_source {
                session.attention = source_attention;
                session.attention_reason = if source_attention {
                    Some("source".into())
                } else {
                    None
                };
            } else {
                // Priority 2: core rules
                let age_sec = now - session.mtime;

                if session.event.as_deref() == Some("tool")
                    && age_sec > rules.tool_stuck_sec as f64
                    && age_sec < 3600.0
                {
                    session.attention = true;
                    session.attention_reason = Some(format!(
                        "tool waiting {}s (threshold: {}s)",
                        age_sec as u32, rules.tool_stuck_sec
                    ));
                    session.event = Some("approval".into());
                } else if session.event.as_deref() == Some("running")
                    && age_sec > rules.running_stuck_sec as f64
                    && age_sec < 3600.0
                {
                    session.attention = true;
                    session.attention_reason = Some(format!(
                        "running {}s (threshold: {}s)",
                        age_sec as u32, rules.running_stuck_sec
                    ));
                    session.event = Some("stuck".into());
                } else if let Some(ref event) = session.event {
                    if rules.waiting_statuses.contains(event) && age_sec < 3600.0 {
                        session.attention = true;
                        session.attention_reason =
                            Some(format!("status: {} ({}s ago)", event, age_sec as u32));
                    } else {
                        session.attention = false;
                        session.attention_reason = None;
                    }
                } else {
                    session.attention = false;
                    session.attention_reason = None;
                }
            }

            // Track attention_since
            if session.attention && !prev_attention {
                session.attention_since = Some(now);
                info!(
                    "[attention] {} needs attention: {:?}",
                    session.name, session.attention_reason
                );
            } else if !session.attention && prev_attention {
                session.attention_since = None;
                debug!("[attention] {} attention cleared", session.name);
            }
        }
    });
}
