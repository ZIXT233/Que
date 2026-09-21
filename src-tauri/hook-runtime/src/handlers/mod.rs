pub mod antigravity;
pub mod claude;
pub mod codebuddy;
pub mod codex;
pub mod cursor;
pub mod devin;
pub mod gemini;
pub mod grok;
use serde_json::{json, Value};
pub fn validate(kind: &str) -> Result<(), &'static str> {
    if matches!(
        kind,
        "grok" | "cursor" | "claude" | "codebuddy" | "antigravity" | "gemini" | "codex"
        | "devin"
    ) {
        Ok(())
    } else {
        Err("unknown harness")
    }
}
pub fn skip(kind: &str, ambient: bool) -> bool {
    (kind != "grok" && std::env::var_os("GROK_HOOK_EVENT").is_some())
        || (kind == "claude" && claude::skip(ambient))
        || (kind == "devin" && ambient && crate::common::internal())
}
pub fn reply(kind: &str, event: Option<&str>) -> Value {
    if kind == "cursor" {
        cursor::reply(event)
    } else {
        json!({})
    }
}
pub fn event<'a>(kind: &str, explicit: Option<&'a str>, payload: &'a Value) -> Option<&'a str> {
    let raw = explicit
        .or_else(|| payload["hook_event_name"].as_str())
        .or_else(|| payload["hookEventName"].as_str())?;
    Some(match kind {
        "grok" => grok::event(raw),
        _ => raw,
    })
}

pub fn accepts(kind: &str, event: &str) -> bool {
    let events = match kind {
        "grok" => grok::EVENTS,
        "cursor" => cursor::EVENTS,
        "claude" | "codebuddy" => claude::EVENTS,
        "antigravity" => antigravity::EVENTS,
        "gemini" => gemini::EVENTS,
        "codex" => codex::EVENTS,
        "devin" => devin::EVENTS,
        _ => return false,
    };
    events.contains(&event)
}
