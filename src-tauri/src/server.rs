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
use std::collections::HashMap;
use std::thread;
use tiny_http::{Header, Request, Response, Server};

/// Directory for persisted hook events (debug + cache)
const EVENTS_DIR: &str = "data/events";

/// Start the HTTP server on the given port (background thread).
pub fn start(store: SessionStore, config: crate::config::ConfigHandle, port: u16, project_root: std::path::PathBuf, app_handle: Option<tauri::AppHandle>) {
    // Bind on 0.0.0.0 so PWA on local network (phone/tablet) can connect
    let addr = format!("0.0.0.0:{}", port);

    thread::spawn(move || {
        let server = match Server::http(&addr) {
            Ok(s) => s,
            Err(e) => {
                error!("[server] failed to bind {}: {}", addr, e);
                return;
            }
        };

        info!("[server] listening on http://{}", addr);

        for mut request in server.incoming_requests() {
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
                    let cfg = config.get_effective();
                    let json = serde_json::to_string(&cfg).unwrap_or_default();
                    respond_json(request, 200, &json);
                }
                ("GET", "/cursor") => {
                    let (x, y) = crate::overlay::get_cursor_position();
                    let b = crate::overlay::overlay_bounds();
                    let displays = crate::overlay::display_rects();
                    let displays_json = serde_json::to_string(&displays).unwrap_or_else(|_| "[]".into());
                    let json = format!(
                        r#"{{"x":{},"y":{},"ox":{},"oy":{},"vw":{},"vh":{},"displays":{}}}"#,
                        x, y, b.x, b.y, b.w, b.h, displays_json
                    );
                    respond_json(request, 200, &json);
                }
                ("POST", "/sessions") => {
                    handle_sessions(request, &store);
                }
                ("POST", "/event") => {
                    handle_event(request, &store, &project_root);
                }
                ("POST", "/kiro-hook") => {
                    handle_kiro_hook(request, &store, &project_root);
                }
                ("POST", "/title") => {
                    handle_title(request, &store, &project_root);
                }
                ("POST", "/character") => {
                    handle_character(request, &store, &project_root);
                }
                ("POST", "/shuffle") => {
                    store.shuffle_characters();
                    request.respond(tiny_http::Response::from_string("{\"ok\":true}")).ok();
                }
                ("POST", "/config") => {
                    handle_config_patch(request, &project_root);
                }
                ("POST", "/runtime") => {
                    // Set transient runtime overrides (not persisted).
                    // Body: { "key": value, ... }
                    let mut body = String::new();
                    if std::io::Read::read_to_string(request.as_reader(), &mut body).is_ok() {
                        if let Ok(map) = serde_json::from_str::<HashMap<String, serde_json::Value>>(&body) {
                            for (k, v) in &map {
                                info!("[server] POST /runtime: {}={}", k, v);
                                config.set_runtime(k, v.clone(), app_handle.as_ref());
                            }
                            respond_json(request, 200, r#"{"ok":true}"#);
                        } else {
                            respond_json(request, 400, r#"{"error":"invalid json"}"#);
                        }
                    } else {
                        respond_json(request, 400, r#"{"error":"read failed"}"#);
                    }
                }
                ("GET", "/runtime") => {
                    // Get current runtime overrides
                    let rt = config.get_runtime_all();
                    let json = serde_json::to_string(&rt).unwrap_or_default();
                    respond_json(request, 200, &json);
                }
                ("GET", url) if url.starts_with("/logs") => {
                    // Serve last N lines from in-memory log buffer
                    let lines_param = url.split("lines=").nth(1)
                        .and_then(|s| s.split('&').next())
                        .and_then(|s| s.parse::<usize>().ok())
                        .unwrap_or(500);
                    let lines = crate::logbuf::tail(lines_param);
                    let total = crate::logbuf::count();
                    let json = serde_json::json!({
                        "lines": lines,
                        "total": total,
                        "showing": lines.len(),
                    });
                    respond_json(request, 200, &json.to_string());
                }
                ("GET", "/characters") => {
                    // Serve all character SVGs as { name: svg_string }
                    let chars_dir = project_root.join("ui").join("characters");
                    let mut svgs = serde_json::Map::new();
                    if let Ok(entries) = std::fs::read_dir(&chars_dir) {
                        for entry in entries.flatten() {
                            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                                let name = entry.file_name().to_string_lossy().to_string();
                                let svg_path = entry.path().join(format!("{}.svg", name));
                                if let Ok(svg) = std::fs::read_to_string(&svg_path) {
                                    svgs.insert(name, serde_json::Value::String(svg));
                                }
                            }
                        }
                    }
                    let json = serde_json::Value::Object(svgs).to_string();
                    respond_json(request, 200, &json);
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
                        workflow_id: None,
                        workflow_name: None,
                        workflow_step_id: None,
                        workflow_step_agent: None,
                        workflow_parent_id: None,
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
                    // Serve PWA static files from pwa/ directory
                    if method == "GET" {
                        let pwa_path = url.strip_prefix("/").unwrap_or(&url);
                        let pwa_path = if pwa_path.is_empty() || pwa_path == "pwa" || pwa_path == "pwa/" {
                            "index.html"
                        } else {
                            pwa_path.strip_prefix("pwa/").unwrap_or(pwa_path)
                        };
                        if let Some(body) = serve_pwa_file(pwa_path, &project_root) {
                            let content_type = match pwa_path.rsplit('.').next() {
                                Some("html") => "text/html; charset=utf-8",
                                Some("js") => "application/javascript",
                                Some("json") => "application/json",
                                Some("png") => "image/png",
                                Some("svg") => "image/svg+xml",
                                Some("css") => "text/css",
                                _ => "application/octet-stream",
                            };
                            let resp = Response::from_data(body)
                                .with_header(content_type.parse::<Header>().unwrap_or_else(|_| content_type_json()))
                                .with_header(cors_origin());
                            let _ = request.respond(resp);
                            continue;
                        }
                    }
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
    persist_event(&update, project_root);

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

fn handle_character(mut request: Request, store: &SessionStore, project_root: &std::path::Path) {
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
    // Persist the pick so it survives restarts/reinstalls (not just localStorage).
    crate::persist_character_to_meta(&update.session_id, &update.character, &project_root.to_path_buf());
    info!("[server] POST /character: {} → {:?}", update.session_id, update.character);
    respond_json(request, 200, r#"{"ok":true}"#);
}

/// Write event to data/events/<session_id>.jsonl for persistence/debugging.
///
/// DEV-ONLY: this is debug history. A downloaded/prod app stays lean — live log
/// inspection is served from the in-memory buffer via GET /logs, so we don't
/// litter the user's disk with per-session event files. In dev we keep them
/// under the project root for debugging.
fn persist_event(update: &EventUpdate, project_root: &std::path::Path) {
    if !cfg!(debug_assertions) {
        return; // prod: no event files on disk
    }
    use std::fs;
    use std::io::Write;

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

/// Serve a PWA static file from the `pwa/` directory.
/// Returns file contents if found, None otherwise.
/// Sanitizes path to prevent directory traversal.
fn serve_pwa_file(path: &str, project_root: &std::path::Path) -> Option<Vec<u8>> {
    // Sanitize: no .., no absolute paths
    if path.contains("..") || path.starts_with('/') {
        return None;
    }
    let file_path = project_root.join("pwa").join(path);
    // Ensure resolved path is within pwa/
    if !file_path.starts_with(project_root.join("pwa")) {
        return None;
    }
    std::fs::read(&file_path).ok()
}


/// POST /kiro-hook — accept raw Kiro hook payload, translate to EventUpdate, push.
/// This replaces the Python hook-dispatch.py + kiro_translate.py pipeline.
/// The Kiro hook config just needs: `curl -s -X POST -d @- http://127.0.0.1:3335/kiro-hook`
fn handle_kiro_hook(mut request: Request, store: &SessionStore, project_root: &std::path::Path) {
    let mut body = String::new();
    if std::io::Read::read_to_string(request.as_reader(), &mut body).is_err() {
        respond_json(request, 400, r#"{"error":"read failed"}"#);
        return;
    }

    let payload: crate::hook::KiroHookPayload = match serde_json::from_str(&body) {
        Ok(p) => p,
        Err(e) => {
            error!("[server] POST /kiro-hook: invalid JSON: {}", e);
            respond_json(request, 400, r#"{"error":"invalid json"}"#);
            return;
        }
    };

    let trigger = payload.trigger.as_deref().unwrap_or("?");
    let session = payload.session_id.as_deref().unwrap_or("?");

    match crate::hook::translate(&payload, store) {
        Some(update) => {
            let event = update.event.clone().unwrap_or_else(|| "?".into());
            let sid = update.session_id.clone();
            store.push_event(update);
            info!("[server] POST /kiro-hook: {} → {} (session={})", trigger, event, sid);
            respond_json(request, 200, r#"{"ok":true}"#);
        }
        None => {
            debug!("[server] POST /kiro-hook: ignored {} for {}", trigger, session);
            respond_json(request, 200, r#"{"ok":true,"ignored":true}"#);
        }
    }
}
