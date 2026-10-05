//! Kiro hook translation — converts raw Kiro hook payloads into nagents EventUpdates.
//!
//! This replaces the Python hook-dispatch.py + kiro_translate.py pipeline with a
//! single Rust endpoint (`POST /kiro-hook`). The Kiro hook config just needs:
//!   `curl -s -X POST -d @- http://127.0.0.1:3335/kiro-hook`
//!
//! The translation logic:
//!   1. Read the raw Kiro JSON payload (trigger, session_id, tool_name, tool_input, etc.)
//!   2. Derive the nagents session_id (ide-{first8}, cli2-{first8}, cli3-{first8})
//!   3. Map the trigger to an EventUpdate (PreToolUse → tool, PostToolUse → running, etc.)
//!   4. Extract display-relevant info (file paths, commands, sub-agents, exit codes)

use crate::state::EventUpdate;
use log::debug;
use serde_json::Value;
use std::collections::HashMap;

/// Raw Kiro hook payload (the JSON Kiro sends on stdin to hook commands).
#[derive(Debug, serde::Deserialize)]
pub struct KiroHookPayload {
    /// Trigger name: "PreToolUse", "PostToolUse", "Stop", "UserPromptSubmit", etc.
    #[serde(alias = "hook_event_name")]
    pub trigger: Option<String>,
    /// Raw Kiro session ID (e.g. "sess_ca95a60c-b0d6-49dc-bf0e-b06579288ee0")
    #[serde(alias = "sessionId")]
    pub session_id: Option<String>,
    /// Tool name (for Pre/PostToolUse)
    #[serde(alias = "toolName")]
    pub tool_name: Option<String>,
    /// Tool input (JSON object with tool-specific params)
    pub tool_input: Option<Value>,
    /// Tool response text (for PostToolUse)
    pub tool_response: Option<String>,
    /// User prompt text (for UserPromptSubmit)
    pub prompt: Option<String>,
}

/// Translate a raw Kiro hook payload into a nagents EventUpdate.
/// Returns None if the payload is invalid or irrelevant.
/// Takes the session store to resolve the correct session ID prefix.
pub fn translate(payload: &KiroHookPayload, store: &crate::state::SessionStore) -> Option<EventUpdate> {
    let trigger = payload.trigger.as_deref().unwrap_or("");
    let raw_session_id = payload.session_id.as_deref().unwrap_or("");
    if raw_session_id.is_empty() {
        return None;
    }

    let session_id = make_session_id(raw_session_id, store);
    if session_id.is_empty() {
        return None;
    }

    let tool_name = payload.tool_name.as_deref().unwrap_or("");
    let tool_input = payload.tool_input.as_ref();
    let tool_response = payload.tool_response.as_deref().unwrap_or("");
    let now = crate::state::now_epoch();

    match trigger {
        "PreToolUse" => {
            let file = extract_file(tool_name, tool_input);
            let mut update = EventUpdate {
                session_id,
                event: Some("tool".into()),
                tool: Some(if tool_name.is_empty() { "unknown".into() } else { tool_name.into() }),
                file: file.map(|f| shorten_path(&f)),
                mtime: Some(now),
                worker: None,
                ..Default::default()
            };
            // Sub-agent spawn
            if tool_name == "invoke_sub_agent" {
                if let Some(input) = tool_input {
                    let name = input.get("name").and_then(|v| v.as_str()).unwrap_or("worker");
                    let short = shorten_agent_name(name);
                    let prompt_text = input.get("prompt").and_then(|v| v.as_str()).unwrap_or("");
                    let desc = prompt_text.lines().next().unwrap_or("").chars().take(50).collect::<String>();
                    let desc = if desc.is_empty() {
                        input.get("explanation").and_then(|v| v.as_str())
                            .unwrap_or("").split('.').next().unwrap_or("")
                            .chars().take(50).collect::<String>()
                    } else { desc };
                    update.worker = Some(if desc.is_empty() { format!("+{}", short) } else { format!("+{}:{}", short, desc) });
                }
            }
            // Workflow launches: step sessions appear via hooks with workflow metadata
            // (read from session.json on disk). No worker push needed — the step
            // sessions cluster around the parent in modes.ts via workflow_parent_id.
            Some(update)
        }
        "PostToolUse" => {
            let mut update = EventUpdate {
                session_id,
                event: Some("running".into()),
                tool: Some(String::new()),
                file: Some(String::new()),
                mtime: Some(now),
                ..Default::default()
            };
            if tool_name == "invoke_sub_agent" {
                if let Some(input) = tool_input {
                    let name = input.get("name").and_then(|v| v.as_str()).unwrap_or("worker");
                    update.worker = Some(format!("-{}", shorten_agent_name(name)));
                }
            } else if tool_name == "execute_bash" {
                update.tool_ok = parse_exit_code(tool_response);
            } else if tool_name == "todo_list" {
                if let Some(result) = parse_todo_result(tool_response) {
                    update.tool_result = Some(result);
                }
            } else if tool_name == "update_session_information" {
                if let Some(input) = tool_input {
                    let desc = input.get("description").and_then(|v| v.as_str());
                    let status = input.get("status").and_then(|v| v.as_str());
                    if let Some(d) = desc {
                        let cleaned = clean_description(d);
                        update.action_text = Some(match status {
                            Some("waiting_on_user") => format!("? {}", cleaned),
                            Some("completed") => format!("✓ {}", cleaned),
                            _ => cleaned.clone(),
                        });
                        update.description = Some(cleaned);
                    }
                    if let Some(s) = status {
                        update.status = Some(s.into());
                    }
                }
            }
            Some(update)
        }
        "Stop" => {
            Some(EventUpdate {
                session_id,
                event: Some("idle".into()),
                priority: Some("low".into()),
                tool: Some(String::new()),
                file: Some(String::new()),
                tool_result: Some(String::new()),
                action_text: Some(String::new()),
                mtime: Some(now),
                ..Default::default()
            })
        }
        "UserPromptSubmit" => {
            let prompt_text = payload.prompt.as_deref()
                .or_else(|| payload.tool_input.as_ref()?.get("prompt")?.as_str())
                .unwrap_or("");
            // Check for nagents: command
            if let Some(cmd) = parse_nagents_command(prompt_text) {
                return Some(cmd);
            }
            Some(EventUpdate {
                session_id,
                event: Some("running".into()),
                prompt: Some(prompt_text.into()),
                tool: Some(String::new()),
                file: Some(String::new()),
                tool_result: Some(String::new()),
                description: Some(String::new()),
                status: Some(String::new()),
                priority: Some(String::new()),
                action_text: Some(String::new()),
                mtime: Some(now),
                ..Default::default()
            })
        }
        _ => {
            debug!("[hook] unknown trigger: {}", trigger);
            None
        }
    }
}

// ─── Session ID ─────────────────────────────────────────────────────────────

/// Convert a raw Kiro session ID to the nagents format.
/// Checks the store for an existing session matching the short UUID with any
/// known prefix (ide-, cli2-, cli3-, crew-). Returns the first match.
/// Falls back to ide-{short} if no existing session found (most common source).
fn make_session_id(raw: &str, store: &crate::state::SessionStore) -> String {
    let uuid = raw.strip_prefix("sess_").unwrap_or(raw);
    let short = &uuid[..uuid.len().min(8)];

    // Check if any existing session contains this short UUID.
    let all = store.get_all();
    for s in &all {
        if s.id.contains(short) {
            return s.id.clone();
        }
    }

    // Default: ide-{short} (IDE is the most common source for Kiro hooks).
    format!("ide-{}", short)
}

// ─── Extraction helpers ─────────────────────────────────────────────────────

fn extract_file(tool_name: &str, tool_input: Option<&Value>) -> Option<String> {
    let input = tool_input?;
    match tool_name {
        "execute_bash" => {
            let cmd = input.get("command")?.as_str()?;
            let parts: Vec<&str> = cmd.split(&['&', '|', ';'][..]).collect();
            let cmds: Vec<String> = parts.iter().filter_map(|p| {
                let words: Vec<&str> = p.trim().split_whitespace().collect();
                let first = words.first()?.rsplit('/').next()?;
                if first == "cd" || first.contains('=') { return None; }
                Some(first.to_string())
            }).take(4).collect();
            if cmds.is_empty() { Some(cmd.chars().take(30).collect()) } else { Some(cmds.join(",")) }
        }
        "read_file" | "read_code" | "str_replace" | "fs_write" | "fs_append" | "delete_file" => {
            input.get("path").or_else(|| input.get("targetFile")).and_then(|v| v.as_str()).map(|s| s.into())
        }
        "grep_search" | "file_search" => {
            input.get("query").and_then(|v| v.as_str()).map(|s| s.into())
        }
        "list_directory" => input.get("path").and_then(|v| v.as_str()).map(|s| s.into()),
        "todo_list" => {
            input.get("command").and_then(|v| v.as_str()).map(|s| format!("todo:{}", s))
        }
        "update_session_information" => {
            input.get("title").or_else(|| input.get("status")).and_then(|v| v.as_str()).map(|s| s.into())
        }
        "invoke_sub_agent" => {
            let name = input.get("name").and_then(|v| v.as_str()).unwrap_or("worker");
            let short = shorten_agent_name(name);
            let prompt_text = input.get("prompt").and_then(|v| v.as_str()).unwrap_or("");
            let desc: String = prompt_text.lines().next().unwrap_or("").chars().take(50).collect();
            if desc.is_empty() { Some(format!("→ {}", short)) } else { Some(format!("{}: {}", short, desc)) }
        }
        "run_workflow" => {
            let label = input.get("runLabel").and_then(|v| v.as_str())
                .or_else(|| input.get("workflowPath").and_then(|v| v.as_str()))
                .unwrap_or("workflow");
            Some(format!("⚙ {}", label))
        }
        _ => input.get("path").or_else(|| input.get("query")).and_then(|v| v.as_str()).map(|s| s.into()),
    }
}

fn shorten_path(path: &str) -> String {
    let home = dirs::home_dir().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
    let mut p = path.to_string();
    if !home.is_empty() && p.starts_with(&home) {
        p = p[home.len() + 1..].to_string();
    }
    for prefix in &["work/tasks/", "work/git/", "work/worktree/"] {
        if p.starts_with(prefix) {
            p = p[prefix.len()..].to_string();
            break;
        }
    }
    p
}

fn parse_exit_code(response: &str) -> Option<bool> {
    let idx = response.rfind("Exit Code: ")?;
    let rest = &response[idx + 11..];
    let code_str = rest.trim().split_whitespace().next()?;
    code_str.parse::<i32>().ok().map(|c| c == 0)
}

fn parse_todo_result(response: &str) -> Option<String> {
    if response.is_empty() { return None; }
    let data: Value = serde_json::from_str(response).ok()?;
    let tasks = data.get("tasks")?.as_array()?;
    if tasks.is_empty() { return None; }
    let total = tasks.len();
    let done = tasks.iter().filter(|t| t.get("completed").and_then(|v| v.as_bool()).unwrap_or(false)).count();
    let current = tasks.iter()
        .find(|t| !t.get("completed").and_then(|v| v.as_bool()).unwrap_or(false))
        .and_then(|t| t.get("task_description"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let current_short: String = current.chars().take(40).collect();
    if current_short.is_empty() {
        Some(format!("{}/{}", done, total))
    } else {
        Some(format!("{}/{}: {}", done, total, current_short))
    }
}

fn parse_nagents_command(prompt: &str) -> Option<EventUpdate> {
    let idx = prompt.find("nagents:")?;
    let rest = &prompt[idx + 8..];
    let line = rest.lines().next()?.trim();
    let parts: Vec<&str> = line.splitn(3, ':').collect();
    if parts.is_empty() || parts[0].is_empty() { return None; }
    let sess_id = parts[0].trim().replace("sess_", "");
    let short = &sess_id[..sess_id.len().min(8)];
    let _group = parts.get(1).map(|s| s.trim()).unwrap_or("");
    let title = parts.get(2).map(|s| s.trim()).unwrap_or("");
    // Return a title-set update (the server's /title handler will persist it)
    // For now, push as a regular event with description = title
    if title.is_empty() { return None; }
    // Try all prefixes
    for prefix in &["ide-", "cli2-", "cli3-"] {
        let session_id = format!("{}{}", prefix, short);
        // We return one — the store's push_event does prefix matching
        return Some(EventUpdate {
            session_id,
            description: Some(title.into()),
            action_text: Some(title.into()),
            ..Default::default()
        });
    }
    None
}

fn clean_description(desc: &str) -> String {
    let prefixes = [
        "Waiting on user decision: ",
        "Waiting on user: ",
        "Blocked on user: ",
        "Waiting for user: ",
        "Need user input: ",
        "Question: ",
    ];
    let mut d = desc.to_string();
    for prefix in &prefixes {
        if d.starts_with(prefix) {
            d = d[prefix.len()..].to_string();
            break;
        }
        if d.to_lowercase().starts_with(&prefix.to_lowercase()) {
            d = d[prefix.len()..].to_string();
            break;
        }
    }
    d
}

static AGENT_SHORT: &[(&str, &str)] = &[
    ("context-gatherer", "cg"),
    ("general-task-execution", "task"),
    ("custom-agent-creator", "creator"),
    ("semantic_reviewer", "reviewer"),
    ("kirocrew-heartbeat", "heartbeat"),
    ("kirocrew-knowledge", "knowledge"),
    ("kirocrew-lite", "lite"),
    ("introspect", "introspect"),
    ("my-default", "default"),
];

fn shorten_agent_name(name: &str) -> String {
    AGENT_SHORT.iter()
        .find(|(k, _)| *k == name)
        .map(|(_, v)| v.to_string())
        .unwrap_or_else(|| name.to_string())
}
