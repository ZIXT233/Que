pub const EVENTS: &[&str] = &[
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PermissionRequest",
    "PostToolUse",
    "Stop",
];
pub fn skip_scope(payload: &serde_json::Value) -> bool {
    matches!(
        (crate::common::internal(), payload["que_scope"].as_str()),
        (true, Some("external")) | (false, Some("internal"))
    )
}
