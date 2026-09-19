pub fn event(raw: &str) -> &str {
    match raw {
        "session_start" => "SessionStart",
        "user_prompt_submit" => "UserPromptSubmit",
        "pre_tool_use" => "PreToolUse",
        "post_tool_use" => "PostToolUse",
        "post_tool_use_failure" => "PostToolUseFailure",
        "stop" => "Stop",
        "stop_failure" => "StopFailure",
        "stop_cancelled" => "StopCancelled",
        "notification" => "Notification",
        _ => raw,
    }
}

pub const EVENTS: &[&str] = &[
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "Stop",
    "StopFailure",
    "StopCancelled",
    "Notification",
];
