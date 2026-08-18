//! In-memory session store.
//!
//! Field ownership:
//!   Scanner owns: id, source, name, workspace, group, tokens, max_tokens, active
//!   Hooks own:    event, attention_source, tool, file
//!   Both write:   mtime (most recent wins)
//!
//! The store merges updates by session_id. Scanner does full-replace of meta fields.
//! Hooks do partial-update of event fields. Neither overwrites the other's fields.

use log::{debug, info};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

/// A single agent session.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Session {
    pub id: String,
    pub source: String,
    pub name: String,
    #[serde(default)]
    pub workspace: String,
    #[serde(default)]
    pub group: String,
    #[serde(default = "default_true")]
    pub active: bool,
    #[serde(default)]
    pub event: Option<String>,
    /// Source-provided attention flag (None = let core rules decide)
    #[serde(default)]
    pub attention_source: Option<bool>,
    /// Computed attention (source + core rules). Updated by attention module.
    #[serde(default)]
    pub attention: bool,
    #[serde(default)]
    pub attention_reason: Option<String>,
    #[serde(default)]
    pub tool: Option<String>,
    #[serde(default)]
    pub file: Option<String>,
    #[serde(default)]
    pub tokens: u64,
    #[serde(default = "default_max_tokens")]
    #[serde(rename = "maxTokens")]
    pub max_tokens: u64,
    #[serde(default = "now_epoch")]
    pub mtime: f64,
    #[serde(default)]
    pub character: Option<String>,
    /// When attention was first set (for recency tracking)
    #[serde(default)]
    pub attention_since: Option<f64>,
    /// Is this session currently shown on overlay?
    #[serde(default)]
    pub on_overlay: bool,
}

/// Event update from hooks (partial update).
#[derive(Debug, Serialize, Deserialize)]
pub struct EventUpdate {
    pub session_id: String,
    #[serde(default)]
    pub event: Option<String>,
    #[serde(default)]
    pub attention: Option<bool>,
    #[serde(default)]
    pub tool: Option<String>,
    #[serde(default)]
    pub file: Option<String>,
    #[serde(default)]
    pub mtime: Option<f64>,
}

/// Full state snapshot (sent to frontend).
#[derive(Debug, Clone, Serialize)]
pub struct StateSnapshot {
    pub sessions: Vec<Session>,
    pub count: usize,
    pub timestamp: f64,
}

fn default_true() -> bool {
    true
}
fn default_max_tokens() -> u64 {
    200_000
}
pub fn now_epoch() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
}

/// Thread-safe session store.
#[derive(Clone)]
pub struct SessionStore {
    inner: Arc<Mutex<HashMap<String, Session>>>,
}

impl SessionStore {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Scanner pushes a batch of sessions for one source.
    /// - Updates meta fields on existing sessions (never touches hook-owned fields).
    /// - Creates new sessions.
    /// - Garbage-collects sessions from this source no longer reported.
    pub fn push_sessions(&self, sessions: Vec<Session>) {
        let source = match sessions.first() {
            Some(s) => s.source.clone(),
            None => return,
        };
        let reported_ids: std::collections::HashSet<String> =
            sessions.iter().map(|s| s.id.clone()).collect();

        let mut store = self.inner.lock().unwrap();

        for session in &sessions {
            if let Some(entry) = store.get_mut(&session.id) {
                // Update meta fields only (scanner-owned)
                entry.name = session.name.clone();
                entry.source = session.source.clone();
                entry.workspace = session.workspace.clone();
                entry.group = session.group.clone();
                entry.active = session.active;
                entry.tokens = session.tokens;
                entry.max_tokens = session.max_tokens;
                if session.mtime > entry.mtime {
                    entry.mtime = session.mtime;
                }
                debug!("[state] updated meta: {} ({})", entry.name, entry.id);
            } else {
                // New session — hook fields start empty
                let mut new_session = session.clone();
                new_session.event = None;
                new_session.attention_source = None;
                new_session.attention = false;
                new_session.attention_reason = None;
                new_session.tool = None;
                new_session.file = None;
                new_session.attention_since = None;
                new_session.on_overlay = false;
                store.insert(session.id.clone(), new_session);
                info!("[state] new session: {} ({})", session.name, session.id);
            }
        }

        // GC: remove sessions from this source no longer reported by scanner
        let dead: Vec<String> = store
            .iter()
            .filter(|(_, v)| v.source == source && !reported_ids.contains(&v.id))
            .map(|(k, _)| k.clone())
            .collect();
        for id in &dead {
            info!("[state] gc removed: {}", id);
            store.remove(id);
        }

        debug!(
            "[state] push_sessions: {} from {} ({} removed)",
            sessions.len(),
            source,
            dead.len()
        );
    }

    /// Hook pushes a partial event update for one session.
    pub fn push_event(&self, update: EventUpdate) -> bool {
        let mut store = self.inner.lock().unwrap();

        // Find session by exact ID or prefix match
        let matching_id = store
            .get(&update.session_id)
            .map(|_| update.session_id.clone())
            .or_else(|| {
                let prefix = if update.session_id.len() >= 8 {
                    &update.session_id[..8]
                } else {
                    &update.session_id
                };
                store.keys().find(|k| k.contains(prefix)).cloned()
            });

        let session = if let Some(id) = matching_id {
            store.get_mut(&id).unwrap()
        } else {
            // Unknown session — create minimal entry (hook arrives before scanner)
            let minimal = Session {
                id: update.session_id.clone(),
                source: String::new(),
                name: update.session_id.clone(),
                workspace: String::new(),
                group: String::new(),
                active: true,
                event: None,
                attention_source: None,
                attention: false,
                attention_reason: None,
                tool: None,
                file: None,
                tokens: 0,
                max_tokens: default_max_tokens(),
                mtime: now_epoch(),
                character: None,
                attention_since: None,
                on_overlay: false,
            };
            info!(
                "[state] hook created minimal session: {}",
                update.session_id
            );
            store.insert(update.session_id.clone(), minimal);
            store.get_mut(&update.session_id).unwrap()
        };

        // Apply hook-owned fields
        if let Some(event) = &update.event {
            session.event = Some(event.clone());
        }
        if let Some(attention) = update.attention {
            session.attention_source = Some(attention);
            // Immediately apply attention change (don't wait for 5s loop)
            session.attention = attention;
            if !attention {
                session.attention_reason = None;
                session.attention_since = None;
                session.on_overlay = false;
            } else {
                session.attention_reason = Some("source".into());
                if session.attention_since.is_none() {
                    session.attention_since = Some(now_epoch());
                }
            }
        }
        // attention=None in update → don't touch attention_source (leave as is)
        if let Some(ref tool) = update.tool {
            session.tool = Some(tool.clone());
        }
        if let Some(ref file) = update.file {
            session.file = Some(file.clone());
        }
        if let Some(mtime) = update.mtime {
            session.mtime = mtime;
        } else {
            session.mtime = now_epoch();
        }

        debug!(
            "[state] event: {} → event={:?}, tool={:?}",
            session.name, session.event, session.tool
        );
        true
    }

    /// Get full state snapshot.
    pub fn snapshot(&self) -> StateSnapshot {
        let store = self.inner.lock().unwrap();
        let sessions: Vec<Session> = store.values().cloned().collect();
        StateSnapshot {
            count: sessions.len(),
            sessions,
            timestamp: now_epoch(),
        }
    }

    /// Get mutable access to all sessions (for attention computation).
    pub fn update_all<F>(&self, f: F)
    where
        F: FnOnce(&mut HashMap<String, Session>),
    {
        let mut store = self.inner.lock().unwrap();
        f(&mut store);
    }

    /// Remove test sessions.
    pub fn clear_test(&self) {
        let mut store = self.inner.lock().unwrap();
        store.retain(|k, _| !k.starts_with("test-"));
    }

    /// Insert a test session.
    pub fn insert_test(&self, session: Session) {
        let mut store = self.inner.lock().unwrap();
        store.insert(session.id.clone(), session);
    }
}
