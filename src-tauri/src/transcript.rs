use crate::paths::{atomic_write, data_dir};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalTranscript {
    pub cwd: String,
    pub output: String,
    pub exit_code: Option<i32>,
}

fn valid_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn transcripts_dir() -> PathBuf {
    data_dir().join("terminal-transcripts")
}

pub fn save_terminal_transcript(id: &str, transcript: &TerminalTranscript) {
    if !valid_id(id) {
        return;
    }
    let file = transcripts_dir().join(format!("{id}.json"));
    let Ok(body) = serde_json::to_string(transcript) else {
        return;
    };
    let _ = atomic_write(&file, &body);
}

pub fn read_terminal_transcript(id: &str) -> Option<TerminalTranscript> {
    if !valid_id(id) {
        return None;
    }
    let body = std::fs::read_to_string(transcripts_dir().join(format!("{id}.json"))).ok()?;
    let saved: serde_json::Value = serde_json::from_str(&body).ok()?;
    let cwd = saved.get("cwd")?.as_str()?.to_string();
    let output = saved.get("output")?.as_str()?.to_string();
    let exit_code = saved
        .get("exitCode")
        .and_then(|v| v.as_i64())
        .map(|n| n as i32);
    Some(TerminalTranscript {
        cwd,
        output,
        exit_code,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_hex_ids() {
        assert!(read_terminal_transcript("not-a-terminal-id").is_none());
        assert!(read_terminal_transcript("23a93d70-bd4e-410e-a0f1-60f052ea6052").is_none());
    }
}
