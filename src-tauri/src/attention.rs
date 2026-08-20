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
                if source_attention {
                    session.attention_reason = Some("source".into());
                } else {
                    session.attention_reason = None;
                }
            } else {
                // Priority 2: core rules
                let age_sec = now - session.mtime;

                if session.event.as_deref() == Some("tool") && age_sec > rules.tool_stuck_sec as f64
                {
                    // Tool event is old — probably waiting for approval
                    // But only if it's recent enough to actually be stuck (not hours-old stale data)
                    if age_sec < 3600.0 {
                        session.attention = true;
                        session.attention_reason = Some(format!(
                            "tool waiting {}s (threshold: {}s)",
                            age_sec as u32, rules.tool_stuck_sec
                        ));
                        // Promote event to "approval" for frontend to show
                        session.event = Some("approval".into());
                        debug!(
                            "[attention] {} → approval (tool {}s)",
                            session.name, age_sec as u32
                        );
                    } else {
                        // Stale event from hours ago — not stuck, just abandoned
                        session.attention = false;
                        session.attention_reason = None;
                    }
                } else if session.event.as_deref() == Some("running")
                    && age_sec > rules.running_stuck_sec as f64
                {
                    // Running too long — probably stuck (but only if recent)
                    if age_sec < 3600.0 {
                        session.attention = true;
                        session.attention_reason = Some(format!(
                            "running {}s (threshold: {}s)",
                            age_sec as u32, rules.running_stuck_sec
                        ));
                        session.event = Some("stuck".into());
                        debug!(
                            "[attention] {} → stuck (running {}s)",
                            session.name, age_sec as u32
                        );
                    } else {
                        session.attention = false;
                        session.attention_reason = None;
                    }
                } else if session.active
                    && age_sec > rules.idle_threshold_sec as f64
                    && session.event.is_none()
                {
                    // Active but idle — might need attention
                    // BUT only if session has had at least one hook event before
                    // (otherwise every scanner-discovered session triggers idle immediately)
                    // Sessions with event=None have never received a hook → skip
                    session.attention = false;
                    session.attention_reason = None;
                } else if let Some(ref event) = session.event {
                    if rules.waiting_statuses.contains(event) {
                        // Waiting/idle status — attention only if mtime is recent
                        // (stale idles from hours ago shouldn't trigger)
                        if age_sec < 3600.0 {
                            session.attention = true;
                            session.attention_reason = Some(format!(
                                "status: {} ({}s ago)", event, age_sec as u32
                            ));
                        } else {
                            session.attention = false;
                            session.attention_reason = None;
                        }
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
