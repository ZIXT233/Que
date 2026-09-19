//! Gemini uses its own turn and tool names, even though it shares ~/.gemini with AGY.
pub const EVENTS: &[&str] = &[
    "SessionStart",
    "BeforeAgent",
    "AfterAgent",
    "BeforeTool",
    "AfterTool",
    "Notification",
];
