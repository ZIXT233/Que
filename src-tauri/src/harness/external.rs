//! Sessions Que never launched.
//!
//! Cursor's user-level `hooks.json` is global, so the same ingress also fires for
//! IDE chats and terminals this app has no terminal id for. Those sessions are not
//! queue cards — no workspace, no pty, nothing to persist — but they still reach
//! attention, so instead of dropping their events they are collected here and
//! surfaced as a transient notice that disappears the moment the session works again.

use super::session_label::{self, clean_text, SessionFacts};
use super::signals::{observe_hook, settle_held, HookSignal, ProbeState};
use crate::live::LiveBus;
use crate::models::ExternalNotice;
use crate::paths::external_signal_dir;
use parking_lot::Mutex;
use regex::Regex;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Working is the real retraction signal. This only retires a notice whose session
/// stopped reporting altogether — an IDE closed mid-prompt never sends one.
const NOTICE_TTL_MS: i64 = 60 * 60 * 1000;
/// Files this old predate the running app; replaying them would resurrect notices
/// the user already dealt with.
const SIGNAL_MAX_AGE_MS: i64 = 10 * 60 * 1000;
/// Waiting cards first, then sessions that are merely working in the background.
const MAX_NOTICES: usize = 12;
const MAX_FILES_PER_TICK: usize = 200;
const POLL_MS: u64 = 500;
/// Preview limit for notification signals and fallbacks.
const PREVIEW_MAX_CHARS: usize = 16_000;
const PROMPT_MAX_CHARS: usize = 4_000;

/// The kind a signal without one is filed under. Cursor is the only harness whose
/// user-level `hooks.json` is global, so its ingress is the one that can fire from a
/// context that carries no kind — this fallback is the single record of that fact.
fn signal_kind(signal: &HookSignal) -> String {
    signal.kind.clone().unwrap_or_else(|| "cursor".into())
}

/// Resolves the true harness kind for an incoming hook signal.
///
/// Third-party runners (like Cursor reading Claude hooks in `~/.claude/settings.json`)
/// may invoke an ingress plugin for a different harness ("claude"). We verify ownership
/// against disk session stores and protect already-identified notices from downgrade.
fn resolve_signal_kind(signal: &HookSignal, existing_kind: Option<&str>) -> String {
    let raw_kind = signal_kind(signal);

    // If we have a concrete session id, check ground-truth disk existence across candidate harnesses.
    if let Some(id) = signal.session_id.as_deref().filter(|s| !s.is_empty()) {
        if raw_kind == "claude" {
            if session_label::session_exists("claude", id) == Some(true) {
                return "claude".into();
            }
            if session_label::session_exists("cursor", id) == Some(true) {
                return "cursor".into();
            }
            if session_label::session_exists("codebuddy", id) == Some(true) {
                return "codebuddy".into();
            }
        } else if raw_kind == "codebuddy" {
            if session_label::session_exists("codebuddy", id) == Some(true) {
                return "codebuddy".into();
            }
            if session_label::session_exists("cursor", id) == Some(true) {
                return "cursor".into();
            }
        }
    }

    // If disk check is inconclusive, protect an existing verified notice (e.g. "cursor")
    // from being downgraded by an incoming "claude" signal for the same session or path key.
    if let Some(existing) = existing_kind {
        if raw_kind == "claude" && existing != "claude" {
            return existing.to_string();
        }
    }

    raw_kind
}

struct Tracked {
    notice: ExternalNotice,
    /// Last event from this session whatever its state, so an uninterrupted
    /// attention wait is not mistaken for a dead session.
    seen_at: i64,
    /// The user closed this notice by hand. Suppressed until the session reports a
    /// newer attention event, which is a genuinely new ask rather than the same one.
    dismissed_at: Option<i64>,
    /// Keep this attention notice off the deck until the user-selected reminder time.
    snoozed_until: Option<i64>,
}

#[derive(Clone)]
pub struct ExternalRuntime {
    notices: Arc<Mutex<HashMap<String, Tracked>>>,
    settings: Option<Arc<crate::settings::SettingsStore>>,
}

impl ExternalRuntime {
    pub fn new(live: LiveBus, settings: Arc<crate::settings::SettingsStore>) -> Self {
        let notices: Arc<Mutex<HashMap<String, Tracked>>> = Arc::new(Mutex::new(HashMap::new()));
        let probes: Arc<Mutex<HashMap<String, ProbeState>>> = Arc::new(Mutex::new(HashMap::new()));
        let watch_notices = notices.clone();
        let watch_settings = settings.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_millis(POLL_MS));
            if drain(&probes, &watch_notices, Some(&watch_settings)) {
                live.notify("external");
            }
        });
        Self {
            notices,
            settings: Some(settings),
        }
    }

    #[cfg(test)]
    pub fn new_test(live: LiveBus) -> Self {
        let notices: Arc<Mutex<HashMap<String, Tracked>>> = Arc::new(Mutex::new(HashMap::new()));
        let probes: Arc<Mutex<HashMap<String, ProbeState>>> = Arc::new(Mutex::new(HashMap::new()));
        let watch_notices = notices.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_millis(POLL_MS));
            if drain(&probes, &watch_notices, None) {
                live.notify("external");
            }
        });
        Self {
            notices,
            settings: None,
        }
    }

    /// Sessions currently on screen, oldest first within each state. Injected into the
    /// queue snapshot on read; `queue.json` never learns about them.
    pub fn notices(&self) -> Vec<ExternalNotice> {
        let settings = self.settings.as_ref().and_then(|s| s.read().ok());
        let now = now_ms();
        let mut notices = self.notices.lock();
        for tracked in notices.values_mut() {
            if tracked.snoozed_until.is_some_and(|until| until <= now) {
                tracked.snoozed_until = None;
            }
        }
        let mut list: Vec<ExternalNotice> = notices
            .values()
            .filter(|tracked| tracked.dismissed_at.is_none())
            .filter(|tracked| tracked.snoozed_until.is_none())
            .filter(|tracked| {
                settings
                    .as_ref()
                    .map(|s| s.is_external_ingress_enabled(&tracked.notice.kind))
                    .unwrap_or(true)
            })
            .map(|tracked| tracked.notice.clone())
            .collect();
        // Truncation drops the oldest, so the ones that want the user come first: a
        // background session must never push a waiting card off the deck.
        list.sort_by_key(|notice| (notice.state != "attention", std::cmp::Reverse(notice.at)));
        list.truncate(MAX_NOTICES);
        list.sort_by_key(|notice| (notice.state != "attention", notice.at));
        list
    }

    /// Take a notice off screen at the user's request. The tracking entry survives so
    /// the same attention event cannot immediately re-raise it; only a newer event
    /// from that session brings it back.
    pub fn dismiss(&self, id: &str) -> bool {
        let mut map = self.notices.lock();
        match map.get_mut(id) {
            Some(tracked) if tracked.dismissed_at.is_none() => {
                tracked.dismissed_at = Some(now_ms());
                true
            }
            _ => false,
        }
    }

    pub fn set_priority_weight(&self, id: &str, weight: i64) -> bool {
        let mut map = self.notices.lock();
        let Some(tracked) = map.get_mut(id) else { return false; };
        tracked.notice.priority_weight = Some(weight);
        true
    }

    pub fn snooze(&self, id: &str, until: i64) -> bool {
        let mut map = self.notices.lock();
        let Some(tracked) = map.get_mut(id) else { return false; };
        if tracked.notice.state != "attention" || tracked.dismissed_at.is_some() {
            return false;
        }
        tracked.snoozed_until = Some(until);
        true
    }
}

fn drain(
    probes: &Mutex<HashMap<String, ProbeState>>,
    notices: &Mutex<HashMap<String, Tracked>>,
    settings: Option<&crate::settings::SettingsStore>,
) -> bool {
    // Expire first: a missing sink directory must not freeze notices on screen.
    let mut changed = expire(probes, notices);
    let is_enabled = |kind: &str| -> bool {
        settings
            .and_then(|s| s.read().ok())
            .map(|set| set.is_external_ingress_enabled(kind))
            .unwrap_or(true)
    };
    // A held guess has no follow-up hook to promote it, so this poll is its clock.
    changed |= promote_held_asks(probes, notices, Some(&is_enabled));
    let Ok(entries) = std::fs::read_dir(external_signal_dir()) else {
        return changed;
    };
    let mut files: Vec<_> = entries
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| signal_name().is_match(name))
        })
        .collect();
    files.sort();
    for path in files.into_iter().take(MAX_FILES_PER_TICK) {
        if let Ok(raw) = std::fs::read_to_string(&path) {
            if let Some(signal) = super::signals::parse_file_signal(&raw) {
                changed |= apply_with_settings(probes, notices, signal, Some(&is_enabled));
            }
        }
        // A malformed file is consumed too: retrying it forever would block the sink.
        let _ = std::fs::remove_file(&path);
    }
    changed
}

#[cfg(test)]
fn apply(
    probes: &Mutex<HashMap<String, ProbeState>>,
    notices: &Mutex<HashMap<String, Tracked>>,
    signal: HookSignal,
) -> bool {
    apply_with_settings(probes, notices, signal, None)
}

fn apply_with_settings(
    probes: &Mutex<HashMap<String, ProbeState>>,
    notices: &Mutex<HashMap<String, Tracked>>,
    signal: HookSignal,
    is_enabled: Option<&dyn Fn(&str) -> bool>,
) -> bool {
    let now = now_ms();
    if signal.agent_id.is_some() || now - signal.at > SIGNAL_MAX_AGE_MS {
        return false;
    }
    let Some(key) = notice_key(&signal) else {
        return false;
    };
    let existing_kind = notices
        .lock()
        .get(&key)
        .map(|tracked| tracked.notice.kind.clone());
    let kind = resolve_signal_kind(&signal, existing_kind.as_deref());
    if let Some(check) = is_enabled {
        if !check(&kind) {
            return false;
        }
    }
    let state = {
        let mut map = probes.lock();
        let current = map.get(&key).cloned().unwrap_or_default();
        let mut resolved_signal = signal.clone();
        resolved_signal.kind = Some(kind.clone());
        let next = observe_hook(current, resolved_signal);
        let state = next.state.clone();
        map.insert(key.clone(), next);
        state
    };
    // A closed chat leaves nothing behind, even though `sessionEnd` folds into the same
    // Stop state a finished turn does.
    if signal.event == "sessionEnd" {
        return notices.lock().remove(&key).is_some();
    }
    // Going back to work is not a retraction: the session keeps a background entry, so
    // the sidebar can show what is running out there as well as who wants the user.
    if state == "working" {
        return set_working(notices, &key, &signal, &kind, now);
    }
    if state != "attention" {
        let mut map = notices.lock();
        if let Some(tracked) = map.get_mut(&key) {
            tracked.seen_at = now;
        }
        return false;
    }
    // Reading the session's own files costs disk work, and the notices lock is read on
    // every snapshot, so it is never held across it. Everything that decides whether
    // this ask is still wanted happens below, under one lock, as it did before.
    let facts = session_facts(&kind, signal.session_id.as_deref());
    let mut map = notices.lock();
    // A hand-dismissed notice stays down until this session asks something newer;
    // re-raising the exact event the user just closed would be a fight, not a feature.
    if let Some(tracked) = map.get_mut(&key) {
        if tracked.dismissed_at.is_some() {
            tracked.seen_at = now;
            if signal.at <= tracked.notice.at {
                return false;
            }
        }
    }
    // The hook reports the workspace the session is running in, which is also what
    // names the card; the chat store only fills in what the hook left out.
    let cwd = signal.workspace_root.clone().or(facts.cwd);
    let priority_weight = map.get(&key).and_then(|tracked| tracked.notice.priority_weight);
    let waiting_since = map
        .get(&key)
        .filter(|tracked| tracked.notice.state == "attention")
        .and_then(|tracked| tracked.notice.waiting_since.or(Some(tracked.notice.at)))
        .or(Some(signal.at));
    let notice = ExternalNotice {
        id: key.clone(),
        kind,
        session_id: signal.session_id.clone(),
        project: cwd.as_deref().and_then(project_name),
        cwd,
        session_name: facts.name,
        prompt: notice_prompt(&signal, facts.prompt),
        state,
        // The session's own store has the reply in full; the hook only ever has a clip.
        // Grok also sends Stop during shutdown, sometimes without the answer.
        // Working clears the previous notice preview, so this never revives an
        // answer from the preceding turn. Preserve its full length and newlines.
        preview: facts
            .reply
            .and_then(|reply| clean_text(&reply, PREVIEW_MAX_CHARS))
            .or_else(|| notice_preview(&signal))
            .or_else(|| {
                map.get(&key)
                    .and_then(|tracked| tracked.notice.preview.clone())
            }),
        turns: facts.turns,
        notification: signal.notification.clone(),
        tool: signal.tool.clone(),
        priority_weight,
        waiting_since,
        at: signal.at,
    };
    // A newer event clears the dismissal, so `changed` must account for the notice
    // becoming visible again even when its own fields are identical.
    let changed = map
        .get(&key)
        .is_none_or(|tracked| tracked.notice != notice || tracked.dismissed_at.is_some());
    map.insert(
        key,
        Tracked {
            notice,
            seen_at: now,
            dismissed_at: None,
            snoozed_until: None,
        },
    );
    changed
}

/// Promote held guesses whose window has run out.
///
/// An external session has no card and no other reader, so its poll is the only clock
/// that can notice a tool never came back. The promoted ask is replayed through the
/// normal ingress, so the notice it raises is built exactly like any other one.
fn promote_held_asks(
    probes: &Mutex<HashMap<String, ProbeState>>,
    notices: &Mutex<HashMap<String, Tracked>>,
    is_enabled: Option<&dyn Fn(&str) -> bool>,
) -> bool {
    let now = now_ms();
    let promoted: Vec<HookSignal> = {
        let mut map = probes.lock();
        let mut out = Vec::new();
        for (key, current) in map.iter_mut() {
            if current.held_attention_at.is_none() {
                continue;
            }
            let Some(next) = settle_held(current.clone(), now) else {
                continue;
            };
            out.push(HookSignal {
                kind: next.kind.clone(),
                at: now,
                event: "PermissionRequest".into(),
                session_id: next.session_id.clone(),
                // Not part of the probe: the tool is only ever known at the moment of
                // the hold, and the notice is the one place that would show it.
                tool: current.held_tool.clone(),
                workspace_root: key.strip_prefix("path:").map(str::to_string),
                external: Some(true),
                ..HookSignal::default()
            });
            *current = next;
        }
        out
    };
    promoted.into_iter().fold(false, |changed, signal| {
        apply_with_settings(probes, notices, signal, is_enabled) || changed
    })
}

/// Track a session that is working. An entry that already exists keeps its identity and
/// only loses what belonged to the previous ask; a session seen working for the first
/// time is described by the hook payload alone, because nothing has asked anything yet.
fn set_working(
    notices: &Mutex<HashMap<String, Tracked>>,
    key: &str,
    signal: &HookSignal,
    kind: &str,
    now: i64,
) -> bool {
    let mut map = notices.lock();
    let mut notice = map
        .get(key)
        .map(|tracked| tracked.notice.clone())
        .unwrap_or_else(|| ExternalNotice {
            id: key.to_string(),
            kind: kind.to_string(),
            session_id: signal.session_id.clone(),
            project: signal.workspace_root.as_deref().and_then(project_name),
            cwd: signal.workspace_root.clone(),
            session_name: None,
            prompt: None,
            turns: Vec::new(),
            state: "working".into(),
            preview: None,
            notification: None,
            tool: None,
            priority_weight: None,
            waiting_since: None,
            at: signal.at,
        });
    notice.kind = kind.to_string();
    notice.state = "working".into();
    notice.at = signal.at;
    // The wait is over, so what described it goes. The ask and the conversation stay:
    // they are how this session is recognised while it works.
    notice.tool = None;
    notice.notification = None;
    notice.preview = None;
    notice.waiting_since = None;
    let changed = map.get(key).is_none_or(|tracked| tracked.notice != notice);
    map.insert(
        key.to_string(),
        Tracked {
            notice,
            seen_at: now,
            dismissed_at: None,
            snoozed_until: None,
        },
    );
    changed
}

fn expire(
    probes: &Mutex<HashMap<String, ProbeState>>,
    notices: &Mutex<HashMap<String, Tracked>>,
) -> bool {
    let now = now_ms();
    let (changed, live): (bool, HashSet<String>) = {
        let mut map = notices.lock();
        let before = map.len();
        map.retain(|_, tracked| now - tracked.seen_at < NOTICE_TTL_MS);
        (map.len() != before, map.keys().cloned().collect())
    };
    // Sessions that no longer show a notice need no bookkeeping; the next attention
    // event rebuilds it from scratch.
    probes.lock().retain(|key, _| live.contains(key));
    changed
}

/// Stable across reloads, and distinct for two chats open in the same workspace.
fn notice_key(signal: &HookSignal) -> Option<String> {
    if let Some(id) = signal.session_id.as_deref() {
        if session_id_pattern().is_match(id) {
            return Some(id.to_string());
        }
    }
    let root = signal
        .workspace_root
        .as_deref()?
        .trim_end_matches(['/', '\\']);
    (!root.is_empty()).then(|| format!("path:{root}"))
}

fn notice_preview(signal: &HookSignal) -> Option<String> {
    clean_text(signal.reply_preview.as_deref()?, PREVIEW_MAX_CHARS)
}

/// The ask this turn answers. The session file knows it even when the hook that
/// raised the notice did not carry one (permission waits never do).
fn notice_prompt(signal: &HookSignal, from_file: Option<String>) -> Option<String> {
    if let Some(prompt) = from_file {
        return clean_text(&prompt, PROMPT_MAX_CHARS);
    }
    let text = signal
        .prompt
        .as_deref()
        .or(signal.first_prompt.as_deref())?;
    clean_text(text, PROMPT_MAX_CHARS)
}

/// What the session's own store knows, read through the one table that says which
/// harness can answer what (`session_label::access`).
fn session_facts(kind: &str, session_id: Option<&str>) -> SessionFacts {
    let Some(id) = session_id.filter(|id| !id.is_empty()) else {
        return SessionFacts::default();
    };
    session_label::session_facts(kind, id)
}

fn project_name(root: &str) -> Option<String> {
    let trimmed = root.trim_end_matches(['/', '\\']);
    let name = trimmed.rsplit(['/', '\\']).next()?;
    (!name.is_empty()).then(|| name.to_string())
}

fn signal_name() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"^\d+-[a-f0-9-]+\.json$").unwrap())
}

fn session_id_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$").unwrap())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::harness::signals::HELD_ATTENTION_MS;

    /// An id no chat store can exist for: the notice reads session files, and a fixture
    /// that happened to match a real session would make these tests machine-dependent.
    const SESSION: &str = "00000000-0000-4000-8000-00000000feed";

    fn signal(event: &str, at: i64) -> HookSignal {
        HookSignal {
            kind: Some("cursor".into()),
            at,
            event: event.into(),
            session_id: Some(SESSION.into()),
            workspace_root: Some("/home/u/Projects/que".into()),
            external: Some(true),
            ..HookSignal::default()
        }
    }

    fn store() -> (
        Mutex<HashMap<String, ProbeState>>,
        Mutex<HashMap<String, Tracked>>,
    ) {
        (Mutex::new(HashMap::new()), Mutex::new(HashMap::new()))
    }

    fn now() -> i64 {
        now_ms()
    }

    fn only(notices: &Mutex<HashMap<String, Tracked>>) -> ExternalNotice {
        notices
            .lock()
            .values()
            .next()
            .map(|tracked| tracked.notice.clone())
            .expect("one notice")
    }

    /// Mirrors `ExternalRuntime::notices`, which needs a running watcher to build.
    fn visible(notices: &Mutex<HashMap<String, Tracked>>) -> Vec<ExternalNotice> {
        let mut list: Vec<ExternalNotice> = notices
            .lock()
            .values()
            .filter(|tracked| tracked.dismissed_at.is_none())
            .map(|tracked| tracked.notice.clone())
            .collect();
        list.sort_by_key(|notice| notice.at);
        list
    }

    fn dismiss(notices: &Mutex<HashMap<String, Tracked>>, id: &str) -> bool {
        match notices.lock().get_mut(id) {
            Some(tracked) if tracked.dismissed_at.is_none() => {
                tracked.dismissed_at = Some(now_ms());
                true
            }
            _ => false,
        }
    }

    #[test]
    fn attention_raises_and_working_keeps_a_background_entry() {
        let (probes, notices) = store();
        let at = now();
        assert!(apply(&probes, &notices, signal("stop", at)));
        let raised = only(&notices);
        assert_eq!(raised.project.as_deref(), Some("que"));
        assert_eq!(raised.state, "attention");
        assert_eq!(raised.id, SESSION);
        // The same attention event must not churn the notice (and its SSE refresh).
        assert!(!apply(&probes, &notices, signal("stop", at)));
        // Back to work: the wait is over, but the session is still out there working.
        assert!(apply(
            &probes,
            &notices,
            signal("beforeSubmitPrompt", at + 1)
        ));
        let working = only(&notices);
        assert_eq!(working.state, "working");
        assert_eq!(working.at, at + 1);
        assert_eq!(working.tool, None);
        // The next ask is a fresh attention event, not a working one repeated.
        assert!(apply(&probes, &notices, signal("stop", at + 2)));
        assert_eq!(only(&notices).state, "attention");
    }

    /// A cursor tool start is a guess, not an ask: it raises nothing until its window
    /// runs out with the tool still silent. This is what keeps the tray quiet while an
    /// external agent reads files.
    #[test]
    fn a_held_tool_start_only_raises_after_its_window() {
        let (probes, notices) = store();
        let at = now() - HELD_ATTENTION_MS;
        assert!(apply(&probes, &notices, signal("preToolUse", at)));
        assert_eq!(only(&notices).state, "working");
        assert_eq!(only(&notices).tool, None);
        // The tool never reported back: the guess is promoted, and once only.
        assert!(promote_held_asks(&probes, &notices, None));
        assert_eq!(only(&notices).state, "attention");
        assert!(!promote_held_asks(&probes, &notices, None));
    }

    /// A tool that answers inside the window retracts the guess: nothing is ever shown.
    #[test]
    fn a_tool_that_answers_retracts_the_hold() {
        let (probes, notices) = store();
        let at = now();
        assert!(apply(&probes, &notices, signal("preToolUse", at)));
        assert!(apply(&probes, &notices, signal("postToolUse", at + 1)));
        assert!(!promote_held_asks(&probes, &notices, None));
        assert_eq!(only(&notices).state, "working");
    }

    #[test]
    fn a_session_first_seen_working_still_gets_an_entry() {
        let (probes, notices) = store();
        assert!(apply(
            &probes,
            &notices,
            signal("beforeSubmitPrompt", now())
        ));
        let entry = only(&notices);
        assert_eq!(entry.state, "working");
        assert_eq!(entry.kind, "cursor");
        assert_eq!(entry.project.as_deref(), Some("que"));
        // Nothing asked yet, so there is nothing to show but who it is.
        assert_eq!(entry.prompt, None);
        assert_eq!(entry.preview, None);
    }

    #[test]
    fn a_finished_turn_raises_a_notice() {
        let (probes, notices) = store();
        let mut stop = signal("stop", now());
        stop.reply_preview = Some("改好了，顺便补了测试。".into());
        assert!(apply(&probes, &notices, stop));
        let raised = only(&notices);
        assert_eq!(raised.preview.as_deref(), Some("改好了，顺便补了测试。"));
        assert_eq!(raised.notification, None);
    }

    #[test]
    fn grok_shutdown_stop_keeps_this_turn_reply_only() {
        let (probes, notices) = store();
        let at = now();
        let mut stop = signal("Stop", at);
        stop.kind = Some("grok".into());
        let reply = "中文回复\n".repeat(80);
        stop.reply_preview = Some(reply.trim().into());
        apply(&probes, &notices, stop.clone());
        stop.at += 1;
        stop.reply_preview = None;
        apply(&probes, &notices, stop.clone());
        assert_eq!(only(&notices).preview.as_deref(), Some(reply.trim()));
        let mut submit = stop.clone();
        submit.at += 1;
        submit.event = "UserPromptSubmit".into();
        apply(&probes, &notices, submit);
        stop.at += 2;
        apply(&probes, &notices, stop);
        assert_eq!(only(&notices).preview, None);
    }

    /// A notice is a card the user cannot type into, so the reply is the content:
    /// it keeps the line breaks a CLI reply is built from instead of collapsing them.
    #[test]
    fn a_reply_keeps_its_lines() {
        let (probes, notices) = store();
        let mut stop = signal("stop", now());
        stop.reply_preview = Some("第一行\n\n\n第二行 \u{7}尾部".into());
        assert!(apply(&probes, &notices, stop));
        assert_eq!(
            only(&notices).preview.as_deref(),
            Some("第一行\n\n第二行 尾部")
        );
    }

    #[test]
    fn a_reply_is_kept_long_enough_to_read() {
        let (probes, notices) = store();
        let mut stop = signal("stop", now());
        stop.reply_preview = Some("x".repeat(20_000));
        assert!(apply(&probes, &notices, stop));
        assert_eq!(
            only(&notices)
                .preview
                .map(|preview| preview.chars().count()),
            Some(PREVIEW_MAX_CHARS)
        );
    }

    /// Permission waits carry no prompt in the hook payload, so the card falls back
    /// to what it can read instead of showing an empty ask.
    #[test]
    fn the_ask_falls_back_to_whatever_the_hook_sent() {
        let mut asked = signal("preToolUse", now());
        asked.prompt = Some("帮我改一下队列排序".into());
        assert_eq!(
            notice_prompt(&asked, None).as_deref(),
            Some("帮我改一下队列排序")
        );
        let mut resumed = signal("preToolUse", now());
        resumed.first_prompt = Some("/resume".into());
        assert_eq!(notice_prompt(&resumed, None).as_deref(), Some("/resume"));
        assert_eq!(
            notice_prompt(&asked, Some("来自会话文件的提问".into())).as_deref(),
            Some("来自会话文件的提问")
        );
        assert_eq!(notice_prompt(&signal("preToolUse", now()), None), None);
    }

    /// The hook's workspace names the card; a chat store that disagrees must not
    /// rename a session the user is looking at.
    #[test]
    fn hook_workspace_names_the_card() {
        let mut reported = signal("stop", now());
        reported.session_id = None;
        reported.workspace_root = Some("/home/u/Projects/que".into());
        let (probes, notices) = store();
        assert!(apply(&probes, &notices, reported));
        let raised = only(&notices);
        assert_eq!(raised.project.as_deref(), Some("que"));
        assert_eq!(raised.cwd.as_deref(), Some("/home/u/Projects/que"));
    }

    #[test]
    fn a_closed_chat_retracts_instead_of_raising() {
        let (probes, notices) = store();
        assert!(apply(&probes, &notices, signal("stop", now())));
        assert!(apply(&probes, &notices, signal("sessionEnd", now() + 1)));
        assert!(notices.lock().is_empty());
    }

    #[test]
    fn subagent_events_are_ignored() {
        let (probes, notices) = store();
        let mut child = signal("preToolUse", now());
        child.agent_id = Some("sub-1".into());
        assert!(!apply(&probes, &notices, child));
        assert!(notices.lock().is_empty());
    }

    #[test]
    fn stale_signals_are_skipped() {
        let (probes, notices) = store();
        assert!(!apply(
            &probes,
            &notices,
            signal("stop", now() - SIGNAL_MAX_AGE_MS - 1)
        ));
        assert!(notices.lock().is_empty());
    }

    #[test]
    fn a_session_without_an_id_falls_back_to_its_workspace() {
        let (probes, notices) = store();
        let mut anonymous = signal("stop", now());
        anonymous.session_id = None;
        assert!(apply(&probes, &notices, anonymous));
        assert_eq!(
            notices.lock().keys().next().map(String::as_str),
            Some("path:/home/u/Projects/que")
        );
    }

    #[test]
    fn project_is_the_last_path_segment() {
        assert_eq!(project_name("/home/u/Projects/que").as_deref(), Some("que"));
        assert_eq!(
            project_name(r"C:\Users\u\Projects\que\\").as_deref(),
            Some("que")
        );
        assert_eq!(project_name("/"), None);
    }

    #[test]
    fn expired_notices_release_their_probe() {
        let (probes, notices) = store();
        apply(&probes, &notices, signal("stop", now()));
        assert_eq!(probes.lock().len(), 1);
        notices
            .lock()
            .values_mut()
            .for_each(|tracked| tracked.seen_at = now() - NOTICE_TTL_MS - 1);
        assert!(expire(&probes, &notices));
        assert!(notices.lock().is_empty());
        assert!(probes.lock().is_empty());
    }

    #[test]
    fn a_dismissed_notice_stays_down_for_the_same_ask() {
        let (probes, notices) = store();
        let at = now();
        apply(&probes, &notices, signal("stop", at));
        assert_eq!(visible(&notices).len(), 1);
        assert!(dismiss(&notices, SESSION));
        assert!(visible(&notices).is_empty());
        assert!(!dismiss(&notices, SESSION));
        // Replaying the very event the user closed must not fight them.
        assert!(!apply(&probes, &notices, signal("stop", at)));
        assert!(visible(&notices).is_empty());
    }

    #[test]
    fn a_newer_ask_clears_the_dismissal() {
        let (probes, notices) = store();
        let at = now();
        apply(&probes, &notices, signal("stop", at));
        dismiss(&notices, SESSION);
        assert!(visible(&notices).is_empty());
        // A fresh attention event is a new ask, so the notice earns its way back.
        assert!(apply(&probes, &notices, signal("stop", at + 1)));
        assert_eq!(visible(&notices).len(), 1);
    }

    #[test]
    fn working_after_a_dismissal_clears_the_tracking() {
        let (probes, notices) = store();
        let at = now();
        apply(&probes, &notices, signal("stop", at));
        dismiss(&notices, SESSION);
        assert!(apply(
            &probes,
            &notices,
            signal("beforeSubmitPrompt", at + 1)
        ));
        // The session went back to work: it is a background entry now, and a hand-close
        // of the old ask does not carry over to the one it is working on.
        let entries = visible(&notices);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].state, "working");
        assert!(apply(&probes, &notices, signal("stop", at + 2)));
        assert_eq!(only(&notices).state, "attention");
    }

    #[test]
    fn disabled_external_ingress_ignores_signals() {
        let (probes, notices) = store();
        let at = now();
        let disabled_cursor = |k: &str| k != "cursor";

        let sig = signal("stop", at);
        assert!(!apply_with_settings(
            &probes,
            &notices,
            sig,
            Some(&disabled_cursor)
        ));
        assert!(notices.lock().is_empty());

        let enabled_cursor = |k: &str| k == "cursor";
        let sig2 = signal("stop", at);
        assert!(apply_with_settings(
            &probes,
            &notices,
            sig2,
            Some(&enabled_cursor)
        ));
        assert_eq!(notices.lock().len(), 1);
    }

    #[test]
    fn existing_cursor_notice_is_not_overwritten_by_unverified_claude_signal() {
        let (probes, notices) = store();
        let at = now();
        let mut cursor_sig = signal("stop", at);
        cursor_sig.kind = Some("cursor".into());
        assert!(apply(&probes, &notices, cursor_sig));
        assert_eq!(only(&notices).kind, "cursor");

        // An unverified claude signal for the same session must not downgrade kind to claude.
        let mut claude_sig = signal("stop", at + 1);
        claude_sig.kind = Some("claude".into());
        assert!(apply(&probes, &notices, claude_sig));
        assert_eq!(only(&notices).kind, "cursor");
    }

    #[test]
    fn resolve_signal_kind_protects_existing_non_claude_kind() {
        let sig = HookSignal {
            kind: Some("claude".into()),
            session_id: Some(SESSION.into()),
            ..HookSignal::default()
        };
        // SESSION has no files on disk. If existing is cursor, it preserves cursor.
        assert_eq!(resolve_signal_kind(&sig, Some("cursor")), "cursor");
        // If no existing kind and no disk files, it falls back to raw kind.
        assert_eq!(resolve_signal_kind(&sig, None), "claude");
    }
}
