use serde_json::{json, Value};
use std::{
    env, fs,
    io::{self, Read},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
pub const MAX_INPUT: usize = 1024 * 1024;
pub fn internal() -> bool {
    nonempty_env("QUE_HARNESS_SIGNAL_DIR").is_some()
        || nonempty_env("QUE_HARNESS_CHANNEL").is_some()
}
fn nonempty_env(key: &str) -> Option<std::ffi::OsString> {
    env::var_os(key).filter(|v| !v.is_empty())
}
/// A complete JSON object is sufficient. Some runners keep stdin open while
/// waiting for our verdict; waiting for EOF would deadlock until their timeout.
pub fn read_payload(mut input: impl Read) -> Result<Value, Box<dyn std::error::Error>> {
    let mut bytes = Vec::new();
    let mut chunk = [0; 4096];
    loop {
        let n = input.read(&mut chunk)?;
        if n == 0 {
            return Err("incomplete hook JSON".into());
        }
        bytes.extend_from_slice(&chunk[..n]);
        if bytes.len() > MAX_INPUT {
            return Err("hook payload exceeds 1 MiB".into());
        }
        if bytes.len() < 3 && [0xef, 0xbb, 0xbf].starts_with(&bytes) {
            continue;
        }
        let body = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes);
        match serde_json::from_slice::<Value>(body) {
            Ok(value) if value.is_object() => return Ok(value),
            Ok(_) => return Err("hook payload must be an object".into()),
            Err(error) if error.is_eof() => {}
            Err(error) => return Err(error.into()),
        }
    }
}
fn first<'a>(payload: &'a Value, fields: &[&str]) -> Option<&'a str> {
    fields.iter().find_map(|key| payload[*key].as_str())
}
fn clean(value: &str, max: usize, multiline: bool) -> String {
    value
        .chars()
        .map(|c| {
            if c.is_control() && !(multiline && c == '\n') {
                ' '
            } else {
                c
            }
        })
        .collect::<String>()
        .trim()
        .chars()
        .take(max)
        .collect()
}
fn sink(dir: &Path, kind: &str) -> io::Result<(PathBuf, bool)> {
    if let Some(path) = nonempty_env("QUE_HARNESS_SIGNAL_DIR") {
        return Ok((path.into(), false));
    }
    // Native ingress is only registered for local Windows. Do not misroute a
    // remote/channel-only invocation into the external notification queue.
    if nonempty_env("QUE_HARNESS_CHANNEL").is_some() {
        return Err(io::Error::other(
            "native hook requires local signal directory",
        ));
    }
    if let Some(path) = nonempty_env("QUE_EXTERNAL_SIGNAL_DIR") {
        return Ok((path.into(), true));
    }
    let name = match kind {
        "grok" => "que-session-state.sink",
        "cursor" => "que-cursor-hook.sink",
        _ => "que-hook.sink",
    };
    if let Ok(path) = fs::read_to_string(dir.join(name)) {
        if !path.trim().is_empty() {
            return Ok((PathBuf::from(path.trim()), true));
        }
    }
    for root in dir.ancestors() {
        if root.file_name().is_some_and(|n| n == "harness-plugins") {
            return Ok((
                root.parent()
                    .ok_or_else(|| io::Error::other("missing profile"))?
                    .join("external-signals"),
                true,
            ));
        }
    }
    Err(io::Error::other("missing external sink configuration"))
}
pub fn deliver(
    dir: &Path,
    kind: &str,
    explicit: Option<&str>,
    payload: &Value,
) -> Result<(), Box<dyn std::error::Error>> {
    let kind = if kind == "codebuddy" && crate::handlers::codebuddy::is_cursor(payload) {
        "cursor"
    } else {
        kind
    };
    let event = crate::handlers::event(kind, explicit, payload).ok_or("missing hook event")?;
    if !crate::handlers::accepts(kind, event) {
        return Err("unknown lifecycle event".into());
    }
    let (directory, external) = sink(dir, kind)?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?;
    let mut signal = json!({"kind":kind,"at":now.as_millis() as u64,"event":event});
    for (target, fields) in [
        (
            "sessionId",
            &[
                "conversationId",
                "conversation_id",
                "session_id",
                "sessionId",
            ][..],
        ),
        ("agentId", &["agent_id", "agentId"][..]),
        ("tool", &["tool_name", "toolName", "name"][..]),
        (
            "notification",
            &["notification_type", "notificationType", "type"][..],
        ),
    ] {
        if let Some(v) = first(payload, fields) {
            signal[target] = json!(v);
        }
    }
    if let Some(tool) = payload.pointer("/toolCall/name").and_then(Value::as_str) {
        signal["tool"] = json!(tool);
    }
    if let Some(idle) = crate::handlers::antigravity::fully_idle(payload) {
        signal["fullyIdle"] = json!(idle);
    }
    if matches!(
        event,
        "UserPromptSubmit" | "beforeSubmitPrompt" | "BeforeAgent"
    ) {
        if let Some(prompt) = payload["prompt"].as_str() {
            signal["prompt"] = json!(clean(
                prompt,
                if kind == "grok" { 4000 } else { 160 },
                kind == "grok"
            ));
        }
    }
    if matches!(event, "Stop" | "stop" | "AfterAgent" | "afterAgentResponse") {
        if let Some(reply) = first(
            payload,
            &[
                "text",
                "last_assistant_message",
                "lastAssistantMessage",
                "prompt_response",
                "response",
                "message",
                "content",
            ],
        ) {
            signal["replyPreview"] = json!(clean(
                reply,
                if external || kind == "grok" {
                    2000
                } else {
                    160
                },
                external || kind == "grok"
            ));
        }
    }
    if external {
        signal["external"] = json!(true);
        let roots = payload
            .get("workspace_roots")
            .or_else(|| payload.get("workspaceRoots"))
            .or_else(|| payload.get("workspace_root"))
            .or_else(|| payload.get("workspaceRoot"))
            .or_else(|| payload.get("cwd"));
        // Devin payloads carry no cwd; the hook process gets DEVIN_PROJECT_DIR.
        let root = roots
            .and_then(|v| {
                if v.is_array() {
                    v[0].as_str()
                } else {
                    v.as_str()
                }
            })
            .map(str::to_owned)
            .or_else(|| {
                nonempty_env("DEVIN_PROJECT_DIR").map(|v| v.to_string_lossy().into_owned())
            });
        if let Some(root) = root {
            signal["workspaceRoot"] = json!(clean(&root, 512, false));
        }
    }
    fs::create_dir_all(&directory)?;
    let name = format!(
        "{}-{:x}-{:x}",
        now.as_millis(),
        std::process::id(),
        now.as_nanos()
    );
    let temporary = directory.join(format!("{name}.tmp"));
    fs::write(&temporary, serde_json::to_vec(&signal)?)?;
    if let Err(error) = fs::rename(&temporary, directory.join(format!("{name}.json"))) {
        let _ = fs::remove_file(temporary);
        return Err(error.into());
    }
    if external {
        prune(&directory);
    }
    Ok(())
}
fn prune(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.ends_with(".json")
            && name
                .trim_end_matches(".json")
                .chars()
                .all(|c| c.is_ascii_hexdigit() || c == '-')
            && entry
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.elapsed().ok())
                .is_some_and(|age| age.as_secs() > 300)
        {
            let _ = fs::remove_file(entry.path());
        }
    }
}
