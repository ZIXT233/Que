//! Reading what a harness recorded: whether a session is still on disk, what to call it,
//! and — for the harnesses that keep a conversation — what was said in it.
//!
//! Which store can answer what is the harness's own business, declared in its
//! `kinds/<kind>.rs` impl. This module only guards the inputs, applies the shared
//! fallback (a store with no transcript still names its session), and hands the kind
//! string to the registry.

use super::label_text::SessionLabel;
use super::registry;
use super::session_find::safe_name_id;
use super::signals::ProbeState;
use crate::models::ExternalTurn;

/// Single-turn content limit: allow large responses and code snippets to be displayed in full.
pub(crate) const TURN_MAX_CHARS: usize = 64_000;

/// What a session's own store knows. A store that records a conversation fills in the
/// turns; one that only knows its name leaves the rest empty.
#[derive(Default)]
pub struct SessionFacts {
    pub name: Option<String>,
    pub cwd: Option<String>,
    pub prompt: Option<String>,
    pub reply: Option<String>,
    pub turns: Vec<ExternalTurn>,
}

pub fn session_exists(kind: &str, session_id: &str) -> Option<bool> {
    if !safe_name_id(session_id) {
        return None;
    }
    registry::find(kind)?.session_exists(session_id)
}

pub fn read_session_label(
    kind: &str,
    session_id: &str,
    need_first_prompt: bool,
) -> Option<SessionLabel> {
    if session_id.is_empty() || session_id.contains('/') || session_id.contains('\\') {
        return None;
    }
    registry::find(kind)?.session_label(session_id, need_first_prompt)
}

/// What the session's own store knows. A store with no transcript still names its
/// session, which is all a notice needs to be recognisable.
pub fn session_facts(kind: &str, session_id: &str) -> SessionFacts {
    if session_id.is_empty() {
        return SessionFacts::default();
    }
    registry::find(kind)
        .map(|harness| harness.session_facts(session_id))
        .unwrap_or_default()
}

pub fn refresh_probe_label(state: &mut ProbeState) {
    let Some(kind) = state.kind.as_deref() else {
        return;
    };
    let Some(harness) = registry::find(kind) else {
        return;
    };
    if !harness.refresh_probe_label() || state.remote {
        return;
    }
    let Some(id) = state.session_id.clone() else {
        return;
    };
    let Some(label) = read_session_label(kind, &id, state.first_prompt.is_none()) else {
        return;
    };
    if let Some(name) = label.name {
        state.session_name = Some(name);
    }
    if let Some(first) = label.first_prompt {
        state.first_prompt = Some(first);
    }
}

/// Trim to what a card can show: keep the line breaks a terminal reply is built from,
/// drop everything else the hooks process may have leaked in.
pub(crate) fn clean_text(text: &str, max: usize) -> Option<String> {
    let kept: String = text
        .chars()
        .filter(|c| *c == '\n' || !c.is_control())
        .take(max)
        .collect();
    let mut lines: Vec<&str> = Vec::new();
    for line in kept.lines() {
        let line = line.trim_end();
        if line.trim().is_empty() && lines.last().is_some_and(|last| last.trim().is_empty()) {
            continue;
        }
        lines.push(line);
    }
    let text = lines.join("\n");
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_kind_is_inconclusive() {
        assert_eq!(session_exists("gemini", "abc"), None);
        assert_eq!(session_exists("opencode", "sess"), None);
        assert_eq!(session_exists("shell", "sess"), None);
    }

    #[test]
    fn missing_cursor_session_is_false() {
        assert_eq!(
            session_exists("cursor", "00000000-0000-0000-0000-000000000000"),
            Some(false)
        );
    }

    #[test]
    fn a_family_member_reads_its_host_store() {
        // Gemini shares Antigravity's brain directory for labels, but has never claimed
        // session existence.
        assert_eq!(
            session_exists("gemini", "00000000-0000-0000-0000-000000000000"),
            None
        );
    }
}
