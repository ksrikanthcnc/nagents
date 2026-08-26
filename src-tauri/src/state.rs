//! In-memory session store.
//!
//! Field ownership:
//!   Scanner owns: id, source, name, workspace, group, tokens, max_tokens, active
//!   Hooks own:    event, tool, file
//!   Both write:   mtime (most recent wins)
//!
//! The store merges updates by session_id. Scanner does full-replace of meta fields.
//! Hooks do partial-update of event fields. Neither overwrites the other's fields.

use log::{debug, info};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Emitter;

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
    /// Computed attention (derived from event age by attention module). Not set by hooks.
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
    /// User-pinned: always visible on overlay, never dots/hides.
    /// Set via panel context menu. Persisted.
    #[serde(default)]
    pub pinned: bool,
    /// User-muted: always hidden on overlay, lowest priority.
    /// For known-useless sessions you want to ignore. Persisted.
    #[serde(default)]
    pub muted: bool,
    /// Last tool success/fail (true=ok, false=error). Cleared on new turn.
    #[serde(default)]
    pub tool_ok: Option<bool>,
    /// Short result text from last tool (e.g. "3/5: Fix stale tool bug"). Cleared on new turn.
    #[serde(default)]
    pub tool_result: Option<String>,
    /// User's latest prompt (full text). Cleared when agent finishes (Stop).
    #[serde(default)]
    pub prompt: Option<String>,
    /// Agent's self-summary of current work (from update_session_information).
    #[serde(default)]
    pub description: Option<String>,
    /// Agent's declared status: "in_progress", "completed", "waiting_on_user", "idle".
    #[serde(default)]
    pub status: Option<String>,
    /// Priority level: "normal" (default), "low" (task done). "high" is app-managed (pinned).
    #[serde(default)]
    pub priority: Option<String>,
    /// Timestamp of last USER interaction (UserPromptSubmit). For LRU/FIFO ordering.
    #[serde(default)]
    pub last_user_ts: Option<f64>,
    /// Number of user interactions (prompts sent). For frequency-based sorting.
    #[serde(default)]
    pub interaction_count: u32,
    /// Pre-formatted action display text. Rendered as-is by overlay. "" = clear.
    #[serde(default)]
    pub action_text: Option<String>,
    /// Number of live sub-agents spawned by this session.
    #[serde(default)]
    pub sub_agents: u32,
    /// Names of active workers/sub-agents.
    #[serde(default)]
    pub workers: Vec<String>,
}

/// Event update from hooks (partial update).
/// Fields set to Some("") mean "clear to None". Fields set to None mean "don't touch".
#[derive(Debug, Serialize, Deserialize)]
pub struct EventUpdate {
    pub session_id: String,
    #[serde(default)]
    pub event: Option<String>,
    #[serde(default)]
    pub tool: Option<String>,
    #[serde(default)]
    pub file: Option<String>,
    #[serde(default)]
    pub mtime: Option<f64>,
    #[serde(default)]
    pub tool_ok: Option<bool>,
    #[serde(default)]
    pub tool_result: Option<String>,
    #[serde(default)]
    pub prompt: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub priority: Option<String>,
    #[serde(default)]
    pub action_text: Option<String>,
    /// Worker lifecycle: "+name" = spawn worker, "-name" = worker done
    #[serde(default)]
    pub worker: Option<String>,
    #[serde(default)]
    pub pinned: Option<bool>,
    #[serde(default)]
    pub muted: Option<bool>,
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

/// Infer source from session ID prefix (e.g. "ide-abc123" → "kiro-ide").
fn infer_source_from_id(session_id: &str) -> String {
    if session_id.starts_with("ide-") {
        "kiro-ide".into()
    } else if session_id.starts_with("cli3-") {
        "kiro-cli-v3".into()
    } else if session_id.starts_with("cli2-") {
        "kiro-cli-v2".into()
    } else if session_id.starts_with("crew-") {
        "kiro-crew".into()
    } else if session_id.starts_with("test-") {
        "kiro-ide".into()
    } else {
        String::new()
    }
}

/// Available character pool for random assignment.
const CHAR_POOL: &[&str] = &[
    "ghost", "cat", "skeleton", "robot", "owl",
    "mushroom", "flame", "crystal", "cloud", "blob",
];

/// Pick a random character from the pool.
fn random_character() -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    use std::time::SystemTime;
    // Simple pseudo-random based on current time nanoseconds
    let seed = SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_nanos();
    let mut hasher = DefaultHasher::new();
    seed.hash(&mut hasher);
    let idx = (hasher.finish() as usize) % CHAR_POOL.len();
    CHAR_POOL[idx].to_string()
}

/// Thread-safe session store.
#[derive(Clone)]
pub struct SessionStore {
    inner: Arc<Mutex<HashMap<String, Session>>>,
    /// Per-source character pools (set from config at startup).
    char_pools: Arc<Mutex<HashMap<String, Vec<String>>>>,
    /// AppHandle for emitting events to frontend windows.
    app_handle: Arc<Mutex<Option<tauri::AppHandle>>>,
}

impl SessionStore {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(HashMap::new())),
            char_pools: Arc::new(Mutex::new(HashMap::new())),
            app_handle: Arc::new(Mutex::new(None)),
        }
    }

    /// Set the AppHandle for emitting events (called once at startup).
    pub fn set_app_handle(&self, handle: tauri::AppHandle) {
        *self.app_handle.lock().unwrap() = Some(handle);
    }

    /// Emit state-changed event to all frontend windows.
    fn emit_state_changed(&self) {
        if let Some(ref handle) = *self.app_handle.lock().unwrap() {
            let _ = handle.emit("state-changed", ());
        }
    }

    /// Set character pools from config (source → list of char IDs).
    pub fn set_char_pools(&self, pools: HashMap<String, Vec<String>>) {
        *self.char_pools.lock().unwrap() = pools;
    }

    /// Clear stale attention on startup: sessions with event != "idle" shouldn't have attention.
    pub fn clear_stale_attention(&self) {
        let mut store = self.inner.lock().unwrap();
        for session in store.values_mut() {
            if session.attention && session.event.as_deref() != Some("idle") {
                session.attention = false;
                
            }
        }
    }

    /// Pick a random character from the source's pool (falls back to global pool).
    fn pick_character(&self, source: &str) -> String {
        let pools = self.char_pools.lock().unwrap();
        let pool = pools.get(source).filter(|p| !p.is_empty());
        let chars: &[String] = match pool {
            Some(p) => p,
            None => return random_character(),
        };
        // Simple pseudo-random
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};
        use std::time::SystemTime;
        let seed = SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .subsec_nanos();
        let mut hasher = DefaultHasher::new();
        seed.hash(&mut hasher);
        let idx = (hasher.finish() as usize) % chars.len();
        chars[idx].clone()
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
                if session.mtime > 0.0 && session.mtime > entry.mtime {
                    entry.mtime = session.mtime;
                }
                debug!("[state] updated meta: {} ({})", entry.name, entry.id);
            } else {
                // New session — hook fields start empty
                let mut new_session = session.clone();
                // If scanner sends mtime=0, set to now (session first-seen time)
                if new_session.mtime <= 0.0 {
                    new_session.mtime = now_epoch();
                }
                new_session.event = None;
                new_session.attention = false;
                new_session.attention_reason = None;
                new_session.tool = None;
                new_session.file = None;
                new_session.attention_since = None;
                new_session.on_overlay = false;
                new_session.tool_ok = None;
                new_session.tool_result = None;
                new_session.prompt = None;
                new_session.description = None;
                new_session.status = None;
                new_session.priority = None;
                new_session.action_text = None;
                new_session.sub_agents = 0;
                new_session.workers = Vec::new();
                // Assign random character from source pool if none set
                if new_session.character.is_none() {
                    new_session.character = Some(self.pick_character(&new_session.source));
                }
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
        // Notify frontend windows
        self.emit_state_changed();
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
            let source = infer_source_from_id(&update.session_id);
            let minimal = Session {
                id: update.session_id.clone(),
                source,
                name: update.session_id.clone(),
                workspace: String::new(),
                group: String::new(),
                active: true,
                event: None,
                
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
                pinned: false,
                muted: false,
                tool_ok: None,
                tool_result: None,
                prompt: None,
                description: None,
                status: None,
                priority: None,
                action_text: None,
                sub_agents: 0,
                workers: Vec::new(),
                last_user_ts: None,
                interaction_count: 0,
            };
            info!(
                "[state] hook created minimal session: {} (source={})",
                update.session_id, minimal.source
            );
            store.insert(update.session_id.clone(), minimal);
            store.get_mut(&update.session_id).unwrap()
        };

        // Apply hook-owned fields
        if let Some(event) = &update.event {
            session.event = Some(event.clone());
        }
        // "" = clear to None, Some(value) = set, None = don't touch
        if let Some(ref tool) = update.tool {
            session.tool = if tool.is_empty() { None } else { Some(tool.clone()) };
        }
        if let Some(ref file) = update.file {
            session.file = if file.is_empty() { None } else { Some(file.clone()) };
        }
        if let Some(ref tool_result) = update.tool_result {
            session.tool_result = if tool_result.is_empty() { None } else { Some(tool_result.clone()) };
        }
        if let Some(ref prompt) = update.prompt {
            session.prompt = if prompt.is_empty() { None } else { Some(prompt.clone()) };
            // Non-empty prompt = user interaction (UserPromptSubmit) → update last_user_ts
            if !prompt.is_empty() {
                session.last_user_ts = Some(now_epoch());
                session.interaction_count += 1;
            }
        }
        if let Some(ref description) = update.description {
            session.description = if description.is_empty() { None } else { Some(description.clone()) };
        }
        if let Some(ref status) = update.status {
            session.status = if status.is_empty() { None } else { Some(status.clone()) };
        }
        if let Some(ref priority) = update.priority {
            session.priority = if priority.is_empty() { None } else { Some(priority.clone()) };
        }
        // tool_ok: None = don't touch (no Option<Option<bool>> needed, just always set when present)
        if update.tool_ok.is_some() {
            session.tool_ok = update.tool_ok;
        }
        if let Some(ref action_text) = update.action_text {
            session.action_text = if action_text.is_empty() { None } else { Some(action_text.clone()) };
        }
        // Worker lifecycle: "+name" = spawn, "-name" = done (matched by short name)
        if let Some(ref worker) = update.worker {
            if let Some(name) = worker.strip_prefix('-') {
                // Worker done: remove by short name prefix match
                let short_name = name.split(':').next().unwrap_or(name).trim();
                if let Some(pos) = session.workers.iter().position(|w| {
                    w.split(':').next().unwrap_or(w).trim() == short_name
                }) {
                    session.workers.remove(pos);
                }
                session.sub_agents = session.sub_agents.saturating_sub(1);
            } else if let Some(name) = worker.strip_prefix('+') {
                // Worker spawn: push (includes explanation)
                session.workers.push(name.to_string());
                session.sub_agents += 1;
            }
        }
        if let Some(pinned) = update.pinned {
            session.pinned = pinned;
            // Pin and mute are mutually exclusive
            if pinned { session.muted = false; }
        }
        if let Some(muted) = update.muted {
            session.muted = muted;
            // Mute and pin are mutually exclusive
            if muted { session.pinned = false; }
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
        self.emit_state_changed();
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
        drop(store);
        self.emit_state_changed();
    }

    /// Set title/name for a session (user or agent assigned).
    pub fn set_title(&self, session_id: &str, title: &str) {
        let mut store = self.inner.lock().unwrap();
        let matching_id = store
            .get(session_id)
            .map(|_| session_id.to_string())
            .or_else(|| store.keys().find(|k| k.starts_with(session_id)).cloned());
        if let Some(id) = matching_id {
            if let Some(session) = store.get_mut(&id) {
                session.name = title.to_string();
                info!("[state] title set: {} → {:?}", id, title);
            }
        } else {
            info!("[state] title set for unknown session: {}", session_id);
        }
    }

    /// Set character for a session (user picked in panel).
    pub fn set_character(&self, session_id: &str, character: &str) {
        let mut store = self.inner.lock().unwrap();
        let matching_id = store
            .get(session_id)
            .map(|_| session_id.to_string())
            .or_else(|| store.keys().find(|k| k.starts_with(session_id)).cloned());
        if let Some(id) = matching_id {
            if let Some(session) = store.get_mut(&id) {
                session.character = Some(character.to_string());
                info!("[state] character set: {} → {:?}", id, character);
            }
        }
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

    /// Restore sessions from a saved snapshot (startup).
    /// Only inserts if session ID is not already present.
    pub fn restore_sessions(&self, sessions: Vec<Session>) {
        let mut store = self.inner.lock().unwrap();
        let mut restored = 0;
        for session in sessions {
            if !store.contains_key(&session.id) {
                store.insert(session.id.clone(), session);
                restored += 1;
            }
        }
        info!("[state] restored {} sessions from snapshot", restored);
    }

    /// Get all sessions as a Vec (for persistence on shutdown).
    pub fn get_all(&self) -> Vec<Session> {
        let store = self.inner.lock().unwrap();
        store.values().cloned().collect()
    }

    /// Get all pinned session IDs (for persistence).
    pub fn get_pinned_ids(&self) -> Vec<String> {
        let store = self.inner.lock().unwrap();
        store.values().filter(|s| s.pinned).map(|s| s.id.clone()).collect()
    }

    /// Restore pinned state from a list of session IDs.
    pub fn restore_pinned(&self, ids: &[String]) {
        let mut store = self.inner.lock().unwrap();
        for id in ids {
            if let Some(session) = store.get_mut(id) {
                session.pinned = true;
            }
        }
        info!("[state] restored {} pinned sessions", ids.len());
    }

    /// Get all muted session IDs (for persistence).
    pub fn get_muted_ids(&self) -> Vec<String> {
        let store = self.inner.lock().unwrap();
        store.values().filter(|s| s.muted).map(|s| s.id.clone()).collect()
    }

    /// Restore muted state from a list of session IDs.
    pub fn restore_muted(&self, ids: &[String]) {
        let mut store = self.inner.lock().unwrap();
        for id in ids {
            if let Some(session) = store.get_mut(id) {
                session.muted = true;
            }
        }
        info!("[state] restored {} muted sessions", ids.len());
    }
}
