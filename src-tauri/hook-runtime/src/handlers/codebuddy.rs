//! Cursor can import CodeBuddy hooks. Preserve the emitting provider identity.
pub fn is_cursor(payload: &serde_json::Value) -> bool {
    [
        "CURSOR_AGENT",
        "CURSOR_CHANNEL",
        "CURSOR_INVOKED_AS",
        "CURSOR_VERSION",
        "CURSOR_PROJECT_DIR",
        "CURSOR_TRACE_ID",
    ]
    .iter()
    .any(|key| std::env::var_os(key).is_some())
        || ((payload["conversationId"].is_string() || payload["conversation_id"].is_string())
            && payload.get("transcript_path").is_none()
            && payload.get("hook_event_name").is_none())
}
