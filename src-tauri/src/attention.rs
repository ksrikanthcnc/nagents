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

            // Compute desired attention state
            let mut desired_attention = false;
            let mut desired_reason: Option<String> = None;
            let mut desired_event_override: Option<String> = None;

            // Priority 1: source explicitly set it
            if let Some(source_attention) = session.attention_source {
                desired_attention = source_attention;
                if source_attention {
                    desired_reason = Some("source".into());
                }
            } else {
                // Priority 2: core rules
                let age_sec = now - session.mtime;

                if session.event.as_deref() == Some("tool") && age_sec > rules.tool_stuck_sec as f64
                {
                    if age_sec < 3600.0 {
                        desired_attention = true;
                        desired_reason = Some(format!(
                            "tool waiting {}s (threshold: {}s)",
                            age_sec as u32, rules.tool_stuck_sec
                        ));
                        desired_event_override = Some("approval".into());
                    }
                } else if session.event.as_deref() == Some("running")
                    && age_sec > rules.running_stuck_sec as f64
                {
                    if age_sec < 3600.0 {
                        desired_attention = true;
                        desired_reason = Some(format!(
                            "running {}s (threshold: {}s)",
                            age_sec as u32, rules.running_stuck_sec
                        ));
                        desired_event_override = Some("stuck".into());
                    }
                } else if let Some(ref event) = session.event {
                    if rules.waiting_statuses.contains(event) && age_sec < 3600.0 {
                        desired_attention = true;
                        desired_reason = Some(format!(
                            "status: {} ({}s ago)", event, age_sec as u32
                        ));
                    }
                }
            }

            // Hysteresis: don't toggle attention if last toggle was < 15s ago
            // (prevents wasteful recomputation churn — mtime sort handles ordering stability)
            if desired_attention != prev_attention {
                let cooldown = 15.0; // seconds
                let can_toggle = match session.attention_toggled_at {
                    Some(toggled_at) => (now - toggled_at) >= cooldown,
                    None => true, // first time — always allow
                };

                if can_toggle {
                    session.attention = desired_attention;
                    session.attention_reason = desired_reason;
                    session.attention_toggled_at = Some(now);
                    if let Some(event_override) = desired_event_override {
                        session.event = Some(event_override);
                    }
                } else {
                    // Hysteresis active — keep previous state, don't toggle
                    debug!(
                        "[attention] {} hysteresis: suppressing toggle (last toggle {:.0}s ago)",
                        session.name,
                        now - session.attention_toggled_at.unwrap_or(0.0)
                    );
                }
            } else {
                // No change in attention — still update reason/event for clarity
                session.attention_reason = desired_reason;
                if let Some(event_override) = desired_event_override {
                    session.event = Some(event_override);
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
