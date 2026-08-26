//! HTTP server for hook pushes and state queries.
//!
//! Endpoints:
//!   GET  /health          → liveness check
//!   GET  /state           → full state snapshot (JSON)
//!   GET  /cursor          → current cursor position (macOS)
//!   POST /sessions        → scanner pushes batch (same as scanner.rs uses internally)
//!   POST /event           → hook pushes partial event update
//!   POST /title           → set session title (user or agent)
//!   GET  /test/start      → create test session
//!   GET  /test/clear      → remove test sessions
//!
//! This allows external tools (hooks, CI, other agents) to push events
//! without being part of the Tauri process.

use crate::state::{now_epoch, EventUpdate, Session, SessionStore};
use log::{debug, error, info};
use std::thread;
use tiny_http::{Header, Request, Response, Server};

/// Directory for persisted hook events (debug + cache)
const EVENTS_DIR: &str = "data/events";

/// Start the HTTP server on the given port (background thread).
pub fn start(store: SessionStore, config: crate::config::ConfigHandle, port: u16, project_root: std::path::PathBuf) {
    let addr = format!("127.0.0.1:{}", port);

    thread::spawn(move || {
        let server = match Server::http(&addr) {
            Ok(s) => s,
            Err(e) => {
                error!("[server] failed to bind {}: {}", addr, e);
                return;
            }
        };

        info!("[server] listening on http://{}", addr);

        for request in server.incoming_requests() {
            let method = request.method().to_string();
            let url = request.url().to_string();
            debug!("[server] {} {}", method, url);

            match (method.as_str(), url.as_str()) {
                ("GET", "/health") => {
                    respond_json(request, 200, r#"{"status":"ok"}"#);
                }
                ("GET", "/state") => {
                    let state = store.snapshot();
                    let json = serde_json::to_string(&state).unwrap_or_default();
                    respond_json(request, 200, &json);
                }
                ("GET", "/config") => {
                    let cfg = config.get();
                    let json = serde_json::to_string(&cfg).unwrap_or_default();
                    respond_json(request, 200, &json);
                }
                ("GET", "/cursor") => {
                    let (x, y) = crate::overlay::get_cursor_position();
                    let json = format!(r#"{{"x":{},"y":{}}}"#, x, y);
                    respond_json(request, 200, &json);
                }
                ("POST", "/sessions") => {
                    handle_sessions(request, &store);
                }
                ("POST", "/event") => {
                    handle_event(request, &store, &project_root);
                }
                ("POST", "/title") => {
                    handle_title(request, &store, &project_root);
                }
                ("POST", "/character") => {
                    handle_character(request, &store);
                }
                ("POST", "/config") => {
                    handle_config_patch(request, &project_root);
                }
                ("GET", "/scan") => {
                    // Force all scanners to run immediately
                    let cfg = config.get();
                    let mut scanned = 0;
                    for (source_id, source_cfg) in &cfg.sources {
                        if !source_cfg.enabled { continue; }
                        if let Some(ref cmd) = source_cfg.scanner {
                            match crate::scanner::run_scanner(cmd, source_id, &project_root) {
                                Ok(sessions) => {
                                    let count = sessions.len();
                                    store.push_sessions(sessions);
                                    scanned += count;
                                }
                                Err(_) => {}
                            }
                        }
                    }
                    let json = format!(r#"{{"ok":true,"scanned":{}}}"#, scanned);
                    respond_json(request, 200, &json);
                }
                ("GET", "/test/start") => {
                    let test = Session {
                        id: "test-001".into(),
                        source: "kiro-ide".into(),
                        name: "Test Session".into(),
                        workspace: "~/test".into(),
                        group: "test".into(),
                        active: true,
                        event: Some("running".into()),
                        
                        attention: false,
                        attention_reason: None,
                        tool: None,
                        file: None,
                        tokens: 50000,
                        max_tokens: 200000,
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
                    store.insert_test(test);
                    info!("[server] TEST: created test session");
                    respond_json(request, 200, r#"{"ok":true,"action":"start"}"#);
                }
                ("GET", "/test/clear") => {
                    store.clear_test();
                    info!("[server] TEST: cleared");
                    respond_json(request, 200, r#"{"ok":true,"action":"clear"}"#);
                }
                ("OPTIONS", _) => {
                    let resp = Response::from_string("")
                        .with_header(cors_origin())
                        .with_header(cors_methods())
                        .with_header(cors_headers());
                    let _ = request.respond(resp);
                }
                _ => {
                    let _ =
                        request.respond(Response::from_string("not found").with_status_code(404));
                }
            }
        }
    });
}

fn handle_sessions(mut request: Request, store: &SessionStore) {
    let mut body = String::new();
    if std::io::Read::read_to_string(request.as_reader(), &mut body).is_err() {
        respond_json(request, 400, r#"{"error":"bad body"}"#);
        return;
    }

    let sessions: Vec<Session> = match serde_json::from_str(&body) {
        Ok(s) => s,
        Err(e) => {
            error!("[server] POST /sessions: invalid JSON: {}", e);
            respond_json(request, 400, r#"{"error":"invalid json"}"#);
            return;
        }
    };

    let count = sessions.len();
    let source = sessions
        .first()
        .map(|s| s.source.clone())
        .unwrap_or_default();
    store.push_sessions(sessions);
    info!("[server] POST /sessions: {} from {}", count, source);
    respond_json(request, 200, r#"{"ok":true}"#);
}

fn handle_event(mut request: Request, store: &SessionStore, project_root: &std::path::Path) {
    let mut body = String::new();
    if std::io::Read::read_to_string(request.as_reader(), &mut body).is_err() {
        respond_json(request, 400, r#"{"error":"bad body"}"#);
        return;
    }

    let update: EventUpdate = match serde_json::from_str(&body) {
        Ok(u) => u,
        Err(e) => {
            error!("[server] POST /event: invalid JSON: {}", e);
            respond_json(request, 400, r#"{"error":"invalid json"}"#);
            return;
        }
    };

    info!(
        "[server] POST /event: {} → event={:?}",
        update.session_id, update.event
    );

    // Persist event to disk for debugging and cache
    persist_event(&update);

    // If pinned or muted state changed, persist immediately
    let needs_meta_persist = update.pinned.is_some() || update.muted.is_some();

    store.push_event(update);

    if needs_meta_persist {
        crate::persist_session_meta(store, &project_root.to_path_buf());
    }

    respond_json(request, 200, r#"{"ok":true}"#);
}

/// Write event to data/events/<session_id>.jsonl for persistence/debugging.
fn handle_title(mut request: Request, store: &SessionStore, project_root: &std::path::Path) {
    let mut body = String::new();
    if std::io::Read::read_to_string(request.as_reader(), &mut body).is_err() {
        respond_json(request, 400, r#"{"error":"bad body"}"#);
        return;
    }

    #[derive(serde::Deserialize)]
    struct TitleUpdate {
        session_id: String,
        title: String,
    }

    let update: TitleUpdate = match serde_json::from_str(&body) {
        Ok(u) => u,
        Err(e) => {
            error!("[server] POST /title: invalid JSON: {}", e);
            respond_json(request, 400, r#"{"error":"invalid json"}"#);
            return;
        }
    };

    // Update in-memory session name
    store.set_title(&update.session_id, &update.title);

    // Persist to data/sessions.json
    crate::persist_title_to_meta(&update.session_id, &update.title, &project_root.to_path_buf());

    info!(
        "[server] POST /title: {} → {:?}",
        update.session_id, update.title
    );
    respond_json(request, 200, r#"{"ok":true}"#);
}

fn handle_character(mut request: Request, store: &SessionStore) {
    let mut body = String::new();
    if std::io::Read::read_to_string(request.as_reader(), &mut body).is_err() {
        respond_json(request, 400, r#"{"error":"bad body"}"#);
        return;
    }

    #[derive(serde::Deserialize)]
    struct CharUpdate {
        session_id: String,
        character: String,
    }

    let update: CharUpdate = match serde_json::from_str(&body) {
        Ok(u) => u,
        Err(e) => {
            error!("[server] POST /character: invalid JSON: {}", e);
            respond_json(request, 400, r#"{"error":"invalid json"}"#);
            return;
        }
    };

    store.set_character(&update.session_id, &update.character);
    info!("[server] POST /character: {} → {:?}", update.session_id, update.character);
    respond_json(request, 200, r#"{"ok":true}"#);
}

/// Write event to data/events/<session_id>.jsonl for persistence/debugging.
fn persist_event(update: &EventUpdate) {
    use std::fs;
    use std::io::Write;
    use std::path::Path;

    let project_root = if cfg!(debug_assertions) {
        let manifest = env!("CARGO_MANIFEST_DIR");
        Path::new(manifest).parent().unwrap_or(Path::new(".")).to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default()
    };

    let events_dir = project_root.join(EVENTS_DIR);
    if fs::create_dir_all(&events_dir).is_err() {
        return;
    }

    let file_path = events_dir.join(format!("{}.jsonl", update.session_id));
    let line = match serde_json::to_string(update) {
        Ok(j) => j,
        Err(_) => return,
    };

    if let Ok(mut file) = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&file_path)
    {
        let _ = writeln!(file, "{}", line);
    }
}

fn respond_json(request: Request, status: u16, body: &str) {
    let resp = Response::from_string(body.to_string())
        .with_status_code(status)
        .with_header(content_type_json())
        .with_header(cors_origin());
    let _ = request.respond(resp);
}

fn content_type_json() -> Header {
    "Content-Type: application/json".parse().unwrap()
}
fn cors_origin() -> Header {
    "Access-Control-Allow-Origin: *".parse().unwrap()
}
fn cors_methods() -> Header {
    "Access-Control-Allow-Methods: GET, POST, OPTIONS"
        .parse()
        .unwrap()
}
fn cors_headers() -> Header {
    "Access-Control-Allow-Headers: Content-Type"
        .parse()
        .unwrap()
}

/// POST /config — patch config.local.yaml with provided JSON keys.
/// Body: JSON object with overlay/attention_rules keys to merge.
/// Writes to config.local.yaml (deep merges with existing local if present).
fn handle_config_patch(mut request: Request, project_root: &std::path::Path) {
    let mut body = String::new();
    if std::io::Read::read_to_string(request.as_reader(), &mut body).is_err() {
        respond_json(request, 400, r#"{"error":"read failed"}"#);
        return;
    }

    // Parse incoming patch as YAML value
    let patch: serde_yaml::Value = match serde_json::from_str::<serde_json::Value>(&body) {
        Ok(json_val) => {
            // Convert JSON to YAML value
            let yaml_str = serde_json::to_string(&json_val).unwrap_or_default();
            serde_yaml::from_str(&yaml_str).unwrap_or(serde_yaml::Value::Null)
        }
        Err(e) => {
            error!("[server] POST /config: invalid JSON: {}", e);
            respond_json(request, 400, r#"{"error":"invalid json"}"#);
            return;
        }
    };

    let local_path = project_root.join("config.local.yaml");

    // Read existing local config (if any)
    let existing: serde_yaml::Value = match std::fs::read_to_string(&local_path) {
        Ok(content) => serde_yaml::from_str(&content).unwrap_or(serde_yaml::Value::Mapping(Default::default())),
        Err(_) => serde_yaml::Value::Mapping(Default::default()),
    };

    // Deep merge patch into existing
    let merged = crate::config::deep_merge_yaml_pub(existing, patch);

    // Write back
    match serde_yaml::to_string(&merged) {
        Ok(yaml_str) => {
            if let Err(e) = std::fs::write(&local_path, yaml_str) {
                error!("[server] POST /config: write error: {}", e);
                respond_json(request, 500, r#"{"error":"write failed"}"#);
                return;
            }
            info!("[server] POST /config: config.local.yaml updated");
            respond_json(request, 200, r#"{"ok":true}"#);
        }
        Err(e) => {
            error!("[server] POST /config: serialize error: {}", e);
            respond_json(request, 500, r#"{"error":"serialize failed"}"#);
        }
    }
}
