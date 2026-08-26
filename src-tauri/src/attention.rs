//! Attention computation — pure time-based.
//!
//! Runs periodically (every 5s). Derives attention from event age:
//!   - event="tool" AND age > tool_stuck_sec → attention + event="approval"
//!   - event="running" AND age > running_stuck_sec → attention + event="stuck"
//!   - event="approval" or "stuck" → maintain attention (already escalated)
//!   - status in waiting_statuses → attention
//!   - Everything else → no attention
//!
//! No attention_source field needed — hooks just update event+mtime.
//! Fresh mtime = no attention (just happened). Stale mtime = might be stuck.

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
            if !session.active {
                if session.attention {
                    session.attention = false;
                    session.attention_reason = None;
                    session.attention_since = None;
                }
                continue;
            }

            let prev_attention = session.attention;
            let age_sec = now - session.mtime;

            // Tool stuck: event="tool" for > threshold → escalate to "approval"
            if session.event.as_deref() == Some("tool")
                && age_sec > rules.tool_stuck_sec as f64
                && age_sec < 3600.0
            {
                session.attention = true;
                session.attention_reason = Some(format!(
                    "tool waiting {}s",
                    age_sec as u32
                ));
                session.event = Some("approval".into());
            }
            // Running stuck: event="running" for > threshold → escalate to "stuck"
            else if session.event.as_deref() == Some("running")
                && age_sec > rules.running_stuck_sec as f64
                && age_sec < 3600.0
            {
                session.attention = true;
                session.attention_reason = Some(format!(
                    "running {}s",
                    age_sec as u32
                ));
                session.event = Some("stuck".into());
            }
            // Already escalated — maintain attention until new event clears it
            else if session.event.as_deref() == Some("approval") {
                session.attention = true;
                if session.attention_reason.is_none() {
                    session.attention_reason = Some("waiting for approval".into());
                }
            }
            else if session.event.as_deref() == Some("stuck") {
                session.attention = true;
                if session.attention_reason.is_none() {
                    session.attention_reason = Some("stuck".into());
                }
            }
            // Waiting statuses (from hook: status field)
            else if let Some(ref status) = session.status {
                if rules.waiting_statuses.contains(status) {
                    session.attention = true;
                    session.attention_reason = Some(format!("status: {}", status));
                } else {
                    session.attention = false;
                    session.attention_reason = None;
                }
            }
            // Default: no attention
            else {
                session.attention = false;
                session.attention_reason = None;
            }

            // Track attention_since
            if session.attention && !prev_attention {
                session.attention_since = Some(now);
                info!(
                    "[attention] {} → attention: {:?}",
                    session.name, session.attention_reason
                );
            } else if !session.attention && prev_attention {
                session.attention_since = None;
                debug!("[attention] {} cleared", session.name);
            }
        }
    });
}
