use super::osc::take_suffix;
use super::signals::ProbeState;
use base64::Engine;
use std::collections::HashMap;

/// Kitty desktop notification (OSC 99). Cursor emits two chunks:
/// title (`p=title`, `d=0`) then body (`p=body`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalNotify {
    pub id: String,
    pub title: Option<String>,
    pub body: Option<String>,
    pub app: Option<String>,
}

pub struct KittyNotifyProbe {
    pending: String,
    legacy: String,
    titles: HashMap<String, String>,
    bodies: HashMap<String, String>,
    apps: HashMap<String, String>,
}

impl KittyNotifyProbe {
    pub fn new() -> Self {
        Self {
            pending: String::new(),
            legacy: String::new(),
            titles: HashMap::new(),
            bodies: HashMap::new(),
            apps: HashMap::new(),
        }
    }

    pub fn push(&mut self, data: &str) -> Option<TerminalNotify> {
        self.push_kitty(data).or_else(|| self.push_legacy(data))
    }

    fn push_kitty(&mut self, data: &str) -> Option<TerminalNotify> {
        self.pending.push_str(data);
        let mut last = None;
        loop {
            let Some(start) = self.pending.find("\x1b]99;") else {
                self.pending = take_suffix(&self.pending, 8);
                break;
            };
            self.pending = self.pending[start..].to_string();
            let Some((end, term_len)) = osc_end(&self.pending) else {
                if self.pending.len() > 16384 {
                    self.pending.clear();
                }
                break;
            };
            if end < 5 {
                self.pending = self.pending[end + term_len..].to_string();
                continue;
            }
            let osc = self.pending[5..end].to_string();
            self.pending = self.pending[end + term_len..].to_string();
            if let Some(notify) = self.consume_frame(&osc) {
                last = Some(notify);
            }
        }
        last
    }

    fn push_legacy(&mut self, data: &str) -> Option<TerminalNotify> {
        self.legacy.push_str(data);
        let mut last = None;
        loop {
            let start_777 = self.legacy.find("\x1b]777;notify;");
            let start_9 = find_iterm_osc9(&self.legacy);
            let picked = match (start_777, start_9) {
                (Some(a), Some(b)) if a <= b => Some((a, 13usize)),
                (Some(_), Some(b)) => Some((b, 4)),
                (Some(a), None) => Some((a, 13)),
                (None, Some(b)) => Some((b, 4)),
                (None, None) => None,
            };
            let Some((start, prefix)) = picked else {
                self.legacy = take_suffix(&self.legacy, 16);
                break;
            };
            self.legacy = self.legacy[start..].to_string();
            let Some((end, term_len)) = osc_end(&self.legacy) else {
                if self.legacy.len() > 16384 {
                    self.legacy.clear();
                }
                break;
            };
            if end < prefix {
                self.legacy = self.legacy[end + term_len..].to_string();
                continue;
            }
            let payload = self.legacy[prefix..end].to_string();
            self.legacy = self.legacy[end + term_len..].to_string();
            last = Some(if prefix == 13 {
                let (title, body) = payload.split_once(';').unwrap_or((payload.as_str(), ""));
                TerminalNotify {
                    id: "osc777".into(),
                    title: nonempty(title),
                    body: nonempty(body),
                    app: nonempty(title),
                }
            } else {
                TerminalNotify {
                    id: "osc9".into(),
                    title: None,
                    body: nonempty(&payload),
                    app: None,
                }
            });
        }
        last
    }

    fn consume_frame(&mut self, osc: &str) -> Option<TerminalNotify> {
        let (meta, payload) = osc.split_once(';').unwrap_or((osc, ""));
        let mut id = "0".to_string();
        let mut part = "title";
        let mut encoded = false;
        let mut done = true;
        let mut app = None;
        for field in meta.split(':').filter(|field| !field.is_empty()) {
            let Some((key, value)) = field.split_once('=') else {
                continue;
            };
            match key {
                "i" => id = value.to_string(),
                "p" => part = value,
                "e" => encoded = value == "1",
                "d" => done = value != "0",
                "f" => app = decode_payload(value, true),
                _ => {}
            }
        }
        let text = decode_payload(payload, encoded).unwrap_or_default();
        if part == "body" {
            self.bodies
                .entry(id.clone())
                .and_modify(|body| body.push_str(&text))
                .or_insert(text);
        } else if part == "title" || part.is_empty() {
            self.titles
                .entry(id.clone())
                .and_modify(|title| title.push_str(&text))
                .or_insert(text);
        }
        if let Some(app) = app {
            self.apps.insert(id.clone(), app);
        }
        if !done {
            return None;
        }
        let title = self.titles.remove(&id);
        let body = self.bodies.remove(&id);
        let app = self.apps.remove(&id);
        if title.as_ref().is_none_or(|value| value.is_empty())
            && body.as_ref().is_none_or(|value| value.is_empty())
        {
            return None;
        }
        Some(TerminalNotify {
            id,
            title,
            body,
            app,
        })
    }
}

/// Cursor looks at `KITTY_WINDOW_ID` before `WT_SESSION` / `TERM_PROGRAM`.
pub fn prefer_kitty_notifications(env: &mut HashMap<String, String>) {
    env.retain(|key, _| !key.eq_ignore_ascii_case("GHOSTTY_RESOURCES_DIR"));
    env.insert("KITTY_WINDOW_ID".into(), "que".into());
}

pub fn observe_notify(current: ProbeState, notify: &TerminalNotify, at: i64) -> ProbeState {
    let mut next = current;
    let preview = notify
        .body
        .as_deref()
        .or(notify.title.as_deref())
        .map(|value| {
            value
                .chars()
                .filter(|c| !c.is_control())
                .take(160)
                .collect::<String>()
        })
        .filter(|value| !value.trim().is_empty());
    if let Some(preview) = preview {
        next.reply_preview = Some(preview);
    }
    if next.state != "attention" {
        next.state = "attention".into();
        next.at = at;
        next.source = Some("notify-osc".into());
    }
    next
}

pub fn notify_osc_kinds(data: &str) -> Vec<&'static str> {
    let mut kinds = Vec::new();
    if data.contains("\x1b]99;") {
        kinds.push("osc99");
    }
    if data.contains("\x1b]777;notify") {
        kinds.push("osc777");
    }
    if find_iterm_osc9(data).is_some() {
        kinds.push("osc9");
    }
    kinds
}

fn find_iterm_osc9(pending: &str) -> Option<usize> {
    let mut search = 0;
    while let Some(rel) = pending[search..].find("\x1b]9;") {
        let idx = search + rel;
        let after = &pending[idx + 4..];
        if !is_conemu_osc9(after) {
            return Some(idx);
        }
        search = idx + 4;
    }
    None
}

fn is_conemu_osc9(after: &str) -> bool {
    after.starts_with("4;")
        || after.starts_with("9;")
        || after.starts_with("12;")
        || after.starts_with("4\u{7}")
        || after.starts_with("9\u{7}")
        || after.starts_with("12\u{7}")
}

fn nonempty(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn osc_end(pending: &str) -> Option<(usize, usize)> {
    let bel = pending.find('\u{7}');
    let st = pending.find("\x1b\\");
    match (bel, st) {
        (Some(a), Some(b)) if a <= b => Some((a, 1)),
        (Some(a), None) => Some((a, 1)),
        (None, Some(b)) => Some((b, 2)),
        _ => None,
    }
}

fn decode_payload(payload: &str, encoded: bool) -> Option<String> {
    if payload.is_empty() {
        return None;
    }
    if !encoded {
        return Some(payload.to_string());
    }
    base64::engine::general_purpose::STANDARD
        .decode(payload.as_bytes())
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b64(text: &str) -> String {
        base64::engine::general_purpose::STANDARD.encode(text.as_bytes())
    }

    #[test]
    fn assembles_cursor_title_then_body() {
        let mut probe = KittyNotifyProbe::new();
        let title = b64("Cursor");
        let body = b64("Cursor is waiting for you");
        assert!(probe
            .push(&format!(
                "\x1b]99;i=cursor:d=0:e=1:f={title}:p=title;{title}\u{7}"
            ))
            .is_none());
        let notify = probe
            .push(&format!("\x1b]99;i=cursor:e=1:p=body;{body}\u{7}"))
            .unwrap();
        assert_eq!(notify.app.as_deref(), Some("Cursor"));
        assert_eq!(notify.title.as_deref(), Some("Cursor"));
        assert_eq!(notify.body.as_deref(), Some("Cursor is waiting for you"));
    }

    #[test]
    fn utf8_tui_does_not_panic_before_osc99() {
        let mut probe = KittyNotifyProbe::new();
        let body = b64("Cursor is waiting for you");
        assert!(probe.push(&"█".repeat(80)).is_none());
        assert!(probe
            .push(&format!(
                "\x1b]99;i=cursor:d=0:e=1:p=title;{}\u{7}",
                b64("Cursor")
            ))
            .is_none());
        let notify = probe
            .push(&format!("\x1b]99;i=cursor:e=1:p=body;{body}\u{7}"))
            .unwrap();
        assert_eq!(notify.body.as_deref(), Some("Cursor is waiting for you"));
    }

    #[test]
    fn survives_chunk_boundary() {
        let mut probe = KittyNotifyProbe::new();
        let body = b64("Approve command: ls");
        probe.push("\x1b]99;i=cursor:e=1:p=bo");
        let notify = probe.push(&format!("dy;{body}\u{7}")).unwrap();
        assert_eq!(notify.body.as_deref(), Some("Approve command: ls"));
    }

    #[test]
    fn observe_notify_does_not_mark_hooks() {
        let current = ProbeState {
            state: "working".into(),
            ..ProbeState::default()
        };
        let next = observe_notify(
            current,
            &TerminalNotify {
                id: "cursor".into(),
                title: Some("Cursor".into()),
                body: Some("Cursor needs your input".into()),
                app: Some("Cursor".into()),
            },
            10,
        );
        assert_eq!(next.state, "attention");
        assert!(!next.hook_seen);
        assert_eq!(next.source.as_deref(), Some("notify-osc"));
        assert_eq!(
            next.reply_preview.as_deref(),
            Some("Cursor needs your input")
        );
    }

    #[test]
    fn parses_iterm_osc9_and_skips_conemu() {
        let mut probe = KittyNotifyProbe::new();
        assert!(probe.push("\x1b]9;4;100\u{7}").is_none());
        let notify = probe.push("\x1b]9;Cursor is waiting for you\u{7}").unwrap();
        assert_eq!(notify.id, "osc9");
        assert_eq!(notify.body.as_deref(), Some("Cursor is waiting for you"));
    }

    #[test]
    fn parses_osc777_notify() {
        let mut probe = KittyNotifyProbe::new();
        let notify = probe
            .push("\x1b]777;notify;Cursor;Cursor needs your input\u{7}")
            .unwrap();
        assert_eq!(notify.id, "osc777");
        assert_eq!(notify.title.as_deref(), Some("Cursor"));
        assert_eq!(notify.body.as_deref(), Some("Cursor needs your input"));
    }

    #[test]
    fn kinds_see_osc_without_assembling() {
        assert_eq!(notify_osc_kinds("hello \x1b]99;i=1;x"), ["osc99"]);
        assert!(notify_osc_kinds("\x1b]9;4;50\u{7}").is_empty());
        assert_eq!(notify_osc_kinds("\x1b]9;hi\u{7}"), ["osc9"]);
    }

    #[test]
    fn observe_notify_keeps_attention_without_replaying() {
        let current = ProbeState {
            state: "attention".into(),
            hook_seen: true,
            source: Some("hook".into()),
            reply_preview: Some("hook preview".into()),
            ..ProbeState::default()
        };
        let next = observe_notify(
            current,
            &TerminalNotify {
                id: "cursor".into(),
                title: Some("Cursor".into()),
                body: Some("Cursor is waiting for you".into()),
                app: None,
            },
            20,
        );
        assert_eq!(next.state, "attention");
        assert!(next.hook_seen);
        assert_eq!(next.source.as_deref(), Some("hook"));
        assert_eq!(
            next.reply_preview.as_deref(),
            Some("Cursor is waiting for you")
        );
    }
}
