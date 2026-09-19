use serde_json::{json, Value};
pub fn reply(event: Option<&str>) -> Value {
    match event {
        Some("beforeSubmitPrompt") => json!({"continue":true}),
        Some("preToolUse" | "beforeShellExecution" | "beforeMCPExecution") => {
            json!({"permission":"allow"})
        }
        _ => json!({}),
    }
}

pub const EVENTS: &[&str] = &[
    "sessionStart",
    "beforeSubmitPrompt",
    "preToolUse",
    "postToolUse",
    "postToolUseFailure",
    "beforeShellExecution",
    "beforeMCPExecution",
    "afterAgentResponse",
    "stop",
    "sessionEnd",
];
