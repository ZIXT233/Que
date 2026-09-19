pub fn skip(ambient: bool) -> bool {
    std::env::var_os("CURSOR_VERSION").is_some() || (ambient && crate::common::internal())
}

pub const EVENTS: &[&str] = &[
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PermissionRequest",
    "Notification",
    "PostToolUse",
    "PostToolUseFailure",
    "Stop",
    "StopFailure",
];
