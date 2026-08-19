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
/// File for user-assigned session titles
const TITLES_FILE: &str = "data/titles.json";

/// Start the HTTP server on the given port (background thread).
pub fn start(store: SessionStore, port: u16) {
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
                ("GET", "/cursor") => {
                    let (x, y) = crate::overlay::get_cursor_position();
                    let json = format!(r#"{{"x":{},"y":{}}}"#, x, y);
                    respond_json(request, 200, &json);
                }
                ("POST", "/sessions") => {
                    handle_sessions(request, &store);
                }
                ("POST", "/event") => {
                    handle_event(request, &store);
                }
                ("POST", "/title") => {
                    handle_title(request, &store);
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
                        attention_source: None,
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

fn handle_event(mut request: Request, store: &SessionStore) {
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

    store.push_event(update);
    respond_json(request, 200, r#"{"ok":true}"#);
}

/// Write event to data/events/<session_id>.jsonl for persistence/debugging.
fn handle_title(mut request: Request, store: &SessionStore) {
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

    // Persist to data/titles.json
    persist_title(&update.session_id, &update.title);

    info!(
        "[server] POST /title: {} → {:?}",
        update.session_id, update.title
    );
    respond_json(request, 200, r#"{"ok":true}"#);
}

/// Persist a title override to data/titles.json.
fn persist_title(session_id: &str, title: &str) {
    use std::collections::HashMap;
    use std::fs;
    use std::path::Path;

    let project_root = if cfg!(debug_assertions) {
        let manifest = env!("CARGO_MANIFEST_DIR");
        Path::new(manifest)
            .parent()
            .unwrap_or(Path::new("."))
            .to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default()
    };

    let titles_path = project_root.join(TITLES_FILE);

    // Ensure data/ dir exists
    if let Some(parent) = titles_path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    // Read existing titles
    let mut titles: HashMap<String, String> = if titles_path.exists() {
        fs::read_to_string(&titles_path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    } else {
        HashMap::new()
    };

    // Update
    titles.insert(session_id.to_string(), title.to_string());

    // Write back
    if let Ok(json) = serde_json::to_string_pretty(&titles) {
        let _ = fs::write(&titles_path, json + "\n");
    }
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
