use super::signals::HookSignal;
use base64::Engine;
use std::time::{SystemTime, UNIX_EPOCH};

pub struct HookOscProbe {
    token: String,
    pending: String,
}

/// Must stay in sync with the prefix harness-hook.cjs writes:
/// `\x1b]777;que;<base64>\x07`. Derive every offset from this constant — a
/// rename that forgets the hardcoded index silently drops every signal.
const MARKER: &str = "\x1b]777;que;";

impl HookOscProbe {
    pub fn new(token: String) -> Self {
        Self {
            token,
            pending: String::new(),
        }
    }

    pub fn push(&mut self, data: &str) -> Option<HookSignal> {
        self.pending.push_str(data);
        loop {
            let Some(start) = self.pending.find(MARKER) else {
                self.pending = take_suffix(&self.pending, MARKER.len());
                return None;
            };
            self.pending = self.pending[start..].to_string();
            let Some(end) = self.pending.find('\u{7}') else {
                if self.pending.len() > 16384 {
                    self.pending.clear();
                }
                return None;
            };
            if end < MARKER.len() {
                self.pending = self.pending[end + 1..].to_string();
                continue;
            }
            let encoded = self.pending[MARKER.len()..end].to_string();
            self.pending = self.pending[end + 1..].to_string();
            if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(encoded) {
                if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                    if value.get("token").and_then(|v| v.as_str()) == Some(self.token.as_str()) {
                        if let Some(signal) = value.get("signal") {
                            if let Ok(mut parsed) =
                                serde_json::from_value::<HookSignal>(signal.clone())
                            {
                                parsed.at = SystemTime::now()
                                    .duration_since(UNIX_EPOCH)
                                    .map(|d| d.as_millis() as i64)
                                    .unwrap_or(0);
                                return Some(parsed);
                            }
                        }
                    }
                }
            }
        }
    }
}

pub(crate) fn take_suffix(value: &str, max: usize) -> String {
    if value.len() <= max {
        return value.to_string();
    }
    let mut start = value.len() - max;
    while start > 0 && !value.is_char_boundary(start) {
        start -= 1;
    }
    value[start..].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encode(token: &str, event: &str) -> String {
        let payload = serde_json::json!({ "token": token, "signal": { "event": event, "at": 1 } });
        base64::engine::general_purpose::STANDARD.encode(payload.to_string())
    }

    #[test]
    fn suffix_does_not_panic_on_multibyte() {
        let text = "你好世界".repeat(8);
        let _ = take_suffix(&text, MARKER.len());
        let mut probe = HookOscProbe::new("token".into());
        assert!(probe.push(&text).is_none());
        assert!(probe.push(&format!("{text}\x1b]777;que;")).is_none());
    }

    #[test]
    fn parses_a_que_signal() {
        let mut probe = HookOscProbe::new("token".into());
        let signal = probe
            .push(&format!(
                "noise\x1b]777;que;{}\x07trailing",
                encode("token", "Stop")
            ))
            .expect("marker length must match the encoded slice");
        assert_eq!(signal.event, "Stop");
    }

    #[test]
    fn parses_a_signal_split_across_chunks() {
        let frame = format!("\x1b]777;que;{}\x07", encode("token", "PreToolUse"));
        let mut probe = HookOscProbe::new("token".into());
        let mut signal = None;
        for (index, chunk) in frame
            .chars()
            .collect::<Vec<_>>()
            .chunks(7)
            .map(|c| c.iter().collect::<String>())
            .enumerate()
        {
            signal = probe.push(&chunk).or(signal);
            let _ = index;
        }
        assert_eq!(signal.expect("split signal must parse").event, "PreToolUse");
    }

    #[test]
    fn rejects_a_foreign_token() {
        let mut probe = HookOscProbe::new("token".into());
        assert!(probe
            .push(&format!("\x1b]777;que;{}\x07", encode("other", "Stop")))
            .is_none());
    }

    #[test]
    fn coalesced_hooks_are_drained_without_waiting_for_another_read() {
        let mut probe = HookOscProbe::new("token".into());
        let output = format!(
            "\x1b]777;que;{}\x07\x1b]777;que;{}\x07",
            encode("token", "UserPromptSubmit"),
            encode("token", "Stop")
        );
        assert_eq!(probe.push(&output).unwrap().event, "UserPromptSubmit");
        assert_eq!(probe.push("").unwrap().event, "Stop");
        assert!(probe.push("").is_none());
    }
}
