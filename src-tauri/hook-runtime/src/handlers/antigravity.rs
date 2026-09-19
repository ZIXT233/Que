//! Stop can pause mid-turn; carry fullyIdle without inventing a completion event.
pub const EVENTS: &[&str] = &[
    "PreInvocation",
    "PostInvocation",
    "PreToolUse",
    "PostToolUse",
    "Stop",
];
pub fn fully_idle(payload: &serde_json::Value) -> Option<bool> {
    payload
        .get("fullyIdle")
        .or_else(|| payload.get("fully_idle"))
        .and_then(serde_json::Value::as_bool)
}
