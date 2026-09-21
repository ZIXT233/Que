/// Devin reuses Claude's hook vocabulary minus `Notification`/`*Failure`, plus its
/// own `SessionEnd`/`PostCompaction`. The payload carries `hook_event_name`, so no
/// per-event argv is needed.
pub const EVENTS: &[&str] = &[
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PermissionRequest",
    "PostToolUse",
    "Stop",
    "SessionEnd",
    "PostCompaction",
];
