use serde::{Deserialize, Serialize};

/// How long a guessed ask is held before it is raised as one.
///
/// Antigravity and Cursor fire the same tool hook whether or not the user is asked:
/// the hook runs *before* their gate, so nothing in the payload says which way it
/// went. A tool that runs on its own reports back within milliseconds; a tool that is
/// really waiting stays silent for as long as the user takes. The window is the only
/// thing that tells the two apart — and it is also its one blind spot: a genuinely
/// long-running tool raises a single late ask once it passes this mark.
pub const HELD_ATTENTION_MS: i64 = 5_000;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct HookSignal {
    pub kind: Option<String>,
    pub at: i64,
    pub event: String,
    pub reply_preview: Option<String>,
    pub session_id: Option<String>,
    pub agent_id: Option<String>,
    pub tool: Option<String>,
    pub prompt: Option<String>,
    pub first_prompt: Option<String>,
    pub title: Option<String>,
    pub notification: Option<String>,
    /// Antigravity says whether a `Stop` really ended the turn; `false` means the CLI
    /// paused mid-turn. Reported as the fact it is — the ingress does not rename the
    /// event into a different one to carry it.
    pub fully_idle: Option<bool>,
    /// Cold-start workspace reported by a global (non-Que) hook.
    pub workspace_root: Option<String>,
    /// Set by the ingress when the emitting process carried no Que channel: the event
    /// belongs to an external session, not to a queue card.
    pub external: Option<bool>,
}

/// Native Grok ingress preserves its envelope without starting a JSON/JS runtime.
/// Other providers keep the existing normalized signal-file contract.
pub fn parse_file_signal(raw: &str) -> Option<HookSignal> {
    let value: serde_json::Value = serde_json::from_str(raw).ok()?;
    if let Some(payload) = value.get("queGrokEnvelope") {
        return super::kinds::grok::native_signal(
            payload,
            value.get("at")?.as_i64()?,
            value.get("external")?.as_bool()?,
        );
    }
    serde_json::from_value(value).ok()
}

#[derive(Debug, Clone, Default)]
pub struct ProbeState {
    pub reply_preview: Option<String>,
    /// Whether this harness's last `Stop` really ended the turn — only a harness whose
    /// stragglers must be suppressed keeps track of it.
    pub turn_completed: bool,
    pub state: String,
    pub at: i64,
    pub shell_command_started_at: Option<i64>,
    pub shell_command_running: Option<bool>,
    pub shell_exit_code: Option<i32>,
    pub kind: Option<String>,
    pub remote: bool,
    pub session_name: Option<String>,
    /// First user prompt from the session file, when that file can be read.
    pub first_prompt: Option<String>,
    /// Last hooked submit on this card. Updates on each submit event.
    pub submit_prompt: Option<String>,
    pub title_state: Option<String>,
    pub title_seen: bool,
    pub hook_seen: bool,
    pub notify_osc_seen: Vec<String>,
    pub notify_osc_hits: u32,
    pub session_id: Option<String>,
    pub identity_at: Option<i64>,
    pub session_id_prefix: Option<String>,
    pub source: Option<String>,
    /// Wall-clock ms when a guessed ask was first seen. While this is set the card
    /// stays in "working": the guess is only promoted to "attention" once the window
    /// passes with no follow-up from the tool.
    pub held_attention_at: Option<i64>,
    /// The tool whose start is being held, so a promoted ask can still name it.
    pub held_tool: Option<String>,
    /// Wall-clock ms when this terminal's *first* hook signal was ingested.
    ///
    /// Together with the PTY probe's `spawned_at_ms` this splits a slow card in
    /// two: `first_hook - spawn` is the second leg (how long the CLI took to
    /// reach its first hook), and comparing it against the CLI's own
    /// `first_byte_ms` tells us whether the cost sat in bootstrap or after it.
    /// First write wins; later hooks never move it.
    pub first_hook_at_ms: Option<i64>,
    /// The terminal's spawn instant, copied in at launch. Kept here (not only on
    /// the PTY probe) so the signal path can compute its own deltas without
    /// reaching across into the terminal module's lock.
    pub spawned_at_ms: Option<i64>,
}

/// What one hook event means for a card.
///
/// A harness's own words are read once, here, and turn straight into what the card does
/// with them. There is deliberately no second vocabulary of "canonical events" in
/// between: such a layer only produced a name that had to be translated again, and it
/// invited renaming an event into a meaning it does not have — which is exactly how
/// Antigravity's tool gate once came to be filed under a permission prompt.
///
/// The states are still two (`working`, `attention`). What this vocabulary adds is the
/// things that are not states: the turn boundaries, which Antigravity needs told apart,
/// and the honest "cannot tell" of a gate the CLI answers itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Meaning {
    /// Not an event this card reacts to.
    Nothing,
    /// A session came up. A card still in `starting` may be waiting on this.
    SessionStart,
    /// A new turn began.
    TurnStart,
    /// A tool is running.
    Working,
    /// A tool start whose gate belongs to the CLI: it may be running, or it may be
    /// asking. Held for [`HELD_ATTENTION_MS`] rather than guessed at.
    MaybeAttention,
    /// The CLI says the user is being asked.
    Attention,
    /// The turn ended: the user is the next actor.
    TurnEnd,
}

/// A tool start whose gate the CLI owns, so the ask is only a guess.
///
/// Cursor answers its own permission hooks on Que's behalf (the ingress returns
/// `allow`), and Antigravity has no permission event at all, so in neither case does
/// the payload say whether the user was asked — every tool call fires these. They are
/// held for [`HELD_ATTENTION_MS`] instead of raised. Which events count is declared by
/// each harness (`kinds/<kind>.rs::guesses_attention`).
///
/// Claude-family CLIs are deliberately absent: their `PreToolUse` is a plain "the tool
/// is running", and a real ask arrives as its own `Notification(permission_prompt)`.
///
/// Tools whose whole purpose is to ask fire for one call only, so the hook *is* the ask
/// and there is nothing to guess about.
fn asks_the_user(tool: &str) -> bool {
    let name = tool.rsplit(['/', '.']).next().unwrap_or(tool);
    matches!(
        name,
        "request_user_input"
            | "ask_user_question"
            | "ask_user"
            | "ask_question"
            | "AskUserQuestion"
    )
}

/// A notification the CLI sends to say a prompt is on screen, rather than to chat.
fn is_ask_notification(signal: &HookSignal) -> bool {
    signal.event == "Notification"
        && ["permission_prompt", "ToolPermission", "idle_prompt"]
            .contains(&signal.notification.as_deref().unwrap_or(""))
}

/// The shared vocabulary every harness's words are read through. The one per-harness
/// input is whether a tool start is a gate the CLI answers itself; everything else is
/// a plain event name.
pub(crate) fn default_meaning(signal: &HookSignal, guesses_attention: bool) -> Meaning {
    if signal.agent_id.is_some() {
        return Meaning::Nothing;
    }
    // An ask-shaped tool is the ask itself, whatever gate the harness owns.
    let tool_start = matches!(
        signal.event.as_str(),
        "PreToolUse" | "BeforeTool" | "preToolUse"
    );
    if tool_start && asks_the_user(signal.tool.as_deref().unwrap_or("")) {
        return Meaning::Attention;
    }
    if guesses_attention {
        return Meaning::MaybeAttention;
    }
    if is_ask_notification(signal) {
        return Meaning::Attention;
    }
    match signal.event.as_str() {
        "SessionStart" | "sessionStart" => Meaning::SessionStart,
        // A prompt was submitted: a new turn.
        "beforeSubmitPrompt" | "UserPromptSubmit" | "BeforeAgent" | "PreInvocation" => {
            Meaning::TurnStart
        }
        // Tool traffic: a turn already in progress.
        "PreToolUse" | "PostToolUse" | "PostToolUseFailure" | "BeforeTool" | "AfterTool"
        | "PostInvocation" | "preToolUse" | "postToolUse" | "postToolUseFailure" => {
            Meaning::Working
        }
        // A turn that ended — unless the harness reports that it only paused.
        "stop" | "Stop" | "StopFailure" | "StopCancelled" | "sessionEnd" | "AfterAgent"
        | "afterAgentResponse" => {
            if signal.fully_idle == Some(false) {
                Meaning::Working
            } else {
                Meaning::TurnEnd
            }
        }
        // A permission act the harness reports itself.
        "PermissionRequest" | "beforeShellExecution" | "beforeMCPExecution" => Meaning::Attention,
        _ => Meaning::Nothing,
    }
}

/// The whole mapping: two states, and nothing to say about the rest.
pub fn hook_state(meaning: Meaning) -> Option<&'static str> {
    match meaning {
        Meaning::Working | Meaning::TurnStart | Meaning::MaybeAttention => Some("working"),
        Meaning::Attention | Meaning::TurnEnd => Some("attention"),
        Meaning::Nothing | Meaning::SessionStart => None,
    }
}

pub fn observe_hook(current: ProbeState, raw: HookSignal) -> ProbeState {
    if raw.agent_id.is_some() {
        return current;
    }
    // The signal's own kind names the harness; an unknown name observes through the
    // generic vocabulary, exactly as it did before that name existed.
    let harness = super::registry::resolve(raw.kind.as_deref().unwrap_or(""));
    let meaning = harness.meaning(&raw);
    let session_id = raw
        .session_id
        .as_deref()
        .filter(|id| {
            regex::Regex::new(r"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$")
                .unwrap()
                .is_match(id)
        })
        .map(|s| s.to_string());
    // Signals already landed on this card (process env). Cursor /resume and TUI
    // session switches often skip sessionStart and reuse a different conversation id.
    let clean = |value: Option<&String>| {
        value
            .map(|s| {
                s.chars()
                    .filter(|c| !c.is_control())
                    .take(160)
                    .collect::<String>()
            })
            .filter(|s| !s.trim().is_empty())
    };
    let new_identity = session_id
        .as_ref()
        .is_some_and(|id| current.session_id.as_ref() != Some(id));
    let mut next = current.clone();
    next.hook_seen = true;
    if new_identity {
        next.session_name = None;
        next.first_prompt = None;
        next.submit_prompt = None;
    }
    // OpenCode: stable OSC title. Others: hook title is a live hint; local file refresh overwrites.
    if let Some(name) = clean(raw.title.as_ref()) {
        next.session_name = Some(name);
    }
    if let Some(first) = clean(raw.first_prompt.as_ref()) {
        next.first_prompt = Some(first);
    }
    // A prompt rides on the submit that starts a turn; a session that merely came up
    // with one attached is not a submit.
    if meaning == Meaning::TurnStart {
        if let Some(prompt) = clean(raw.prompt.as_ref()) {
            next.submit_prompt = Some(prompt);
        }
    }
    if let Some(id) = session_id {
        if raw.at >= current.identity_at.unwrap_or(0) {
            next.session_id = Some(id);
            next.session_id_prefix = None;
            next.identity_at = Some(raw.at);
        }
    }
    if raw.at < current.at {
        return next;
    }
    // A harness that files stragglers once a turn really ended needs the two turn
    // boundaries told apart from the states it also reports.
    if harness.suppresses_stragglers()
        && current.turn_completed
        && !new_identity
        && meaning != Meaning::TurnStart
        && meaning != Meaning::TurnEnd
    {
        return next;
    }
    if harness.suppresses_stragglers() {
        next.turn_completed = meaning == Meaning::TurnEnd;
    }
    if let Some(state) = hook_state(meaning) {
        next.reply_preview = if state == "working" {
            None
        } else {
            clean(raw.reply_preview.as_ref()).or_else(|| {
                if new_identity {
                    None
                } else {
                    current.reply_preview.clone()
                }
            })
        };
        next.state = state.into();
        next.at = raw.at;
        next.source = Some("hook".into());
        if meaning == Meaning::MaybeAttention {
            // The first guess stamps the clock and later ones leave it alone: a tool
            // that keeps reporting but never finishes must not push its own deadline
            // forward forever. Anything else the hook states clears the hold.
            next.held_attention_at = Some(next.held_attention_at.unwrap_or(raw.at));
            next.held_tool = raw.tool.clone().or_else(|| next.held_tool.clone());
        } else {
            next.held_attention_at = None;
            next.held_tool = None;
        }
    } else if meaning == Meaning::SessionStart && current.state == "starting" {
        next.state = "attention".into();
    }
    next
}

/// Promote a held guess whose window has run out.
///
/// A tool that owns its own progress answers inside the window, so a hold this old
/// means the CLI has been sitting on a prompt after all — the ask the hook itself
/// could not report. Returns `None` while the guess is still inside its window.
pub fn settle_held(current: ProbeState, now: i64) -> Option<ProbeState> {
    let held = current.held_attention_at?;
    if now - held < HELD_ATTENTION_MS {
        return None;
    }
    // Something already spoke for this card — the CLI's own title, a notification, a
    // turn end. There is no guess left to promote, and raising it again would undo
    // whatever the user just did with it.
    if current.state != "working" {
        return None;
    }
    Some(ProbeState {
        held_attention_at: None,
        held_tool: None,
        state: "attention".into(),
        at: now,
        source: Some("hook".into()),
        ..current
    })
}

/// Last writer wins: any source that reports a state change updates the card.
/// A missed transition (hook lost to a timeout, CLI aborting a turn without a
/// Stop) leaves the card stuck far longer than a flapped state does, so the
/// title probe is never demoted — even when hooks have been seen.
pub fn observe_title(current: ProbeState, state: &str, at: i64) -> ProbeState {
    let mut next = current;
    if next.title_state.as_deref() == Some(state) {
        next.title_seen = true;
        return next;
    }
    next.title_seen = true;
    next.title_state = Some(state.into());
    next.state = state.into();
    next.at = at;
    next.source = Some("title".into());
    next
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::harness::registry;

    /// Claude-family `PreToolUse` means "the tool is running", so a CodeBuddy tool
    /// call stays "working"; only a bare turn end, or a prompt notification, waits
    /// on the user. Notification is what a blocked ask actually arrives through.
    #[test]
    fn codebuddy_tools_are_working_and_prompts_are_attention() {
        let edit = HookSignal {
            kind: Some("codebuddy".into()),
            event: "PreToolUse".into(),
            tool: Some("Explain".into()),
            at: 1,
            ..HookSignal::default()
        };
        assert_eq!(
            hook_state(registry::resolve("codebuddy").meaning(&edit)),
            Some("working")
        );

        let stop = HookSignal {
            kind: Some("codebuddy".into()),
            event: "Stop".into(),
            at: 2,
            ..HookSignal::default()
        };
        assert_eq!(
            hook_state(registry::resolve("codebuddy").meaning(&stop)),
            Some("attention")
        );

        let blocked = HookSignal {
            kind: Some("codebuddy".into()),
            event: "Notification".into(),
            notification: Some("permission_prompt".into()),
            at: 3,
            ..HookSignal::default()
        };
        assert_eq!(
            hook_state(registry::resolve("codebuddy").meaning(&blocked)),
            Some("attention")
        );
    }

    /// The translation table is the whole contract: one row per thing a harness can say,
    /// and the conclusion Que draws from it. Nothing downstream reads an event name.
    #[test]
    fn every_event_lands_on_one_conclusion() {
        let cases = [
            ("sessionStart", Meaning::SessionStart),
            ("SessionStart", Meaning::SessionStart),
            ("beforeSubmitPrompt", Meaning::TurnStart),
            ("UserPromptSubmit", Meaning::TurnStart),
            ("BeforeAgent", Meaning::TurnStart),
            ("PreInvocation", Meaning::TurnStart),
            ("PreToolUse", Meaning::Working),
            ("PostToolUse", Meaning::Working),
            ("postToolUseFailure", Meaning::Working),
            ("AfterTool", Meaning::Working),
            ("stop", Meaning::TurnEnd),
            ("sessionEnd", Meaning::TurnEnd),
            ("afterAgentResponse", Meaning::TurnEnd),
            ("SessionInfo", Meaning::Nothing),
        ];
        for (event, expected) in cases {
            let signal = HookSignal {
                kind: Some("claude".into()),
                event: event.into(),
                at: 1,
                ..HookSignal::default()
            };
            assert_eq!(
                registry::resolve("claude").meaning(&signal),
                expected,
                "{event}"
            );
        }
        // The two things that are not simply a state: a gate the CLI owns, and an ask the
        // CLI states outright.
        let gate = HookSignal {
            kind: Some("cursor".into()),
            event: "preToolUse".into(),
            at: 1,
            ..HookSignal::default()
        };
        assert_eq!(
            registry::resolve("cursor").meaning(&gate),
            Meaning::MaybeAttention
        );
        let asked = HookSignal {
            kind: Some("claude".into()),
            event: "Notification".into(),
            notification: Some("permission_prompt".into()),
            at: 1,
            ..HookSignal::default()
        };
        assert_eq!(
            registry::resolve("claude").meaning(&asked),
            Meaning::Attention
        );
        // A subagent's events are nobody's card.
        let child = HookSignal {
            kind: Some("claude".into()),
            event: "Stop".into(),
            agent_id: Some("sub".into()),
            at: 1,
            ..HookSignal::default()
        };
        assert_eq!(
            registry::resolve("claude").meaning(&child),
            Meaning::Nothing
        );
    }

    #[test]
    fn last_submit_prompt_wins() {
        let started = observe_hook(
            ProbeState::default(),
            HookSignal {
                event: "sessionStart".into(),
                at: 1,
                session_id: Some("s1".into()),
                ..HookSignal::default()
            },
        );
        let first = observe_hook(
            started,
            HookSignal {
                event: "beforeSubmitPrompt".into(),
                at: 2,
                session_id: Some("s1".into()),
                prompt: Some("first".into()),
                ..HookSignal::default()
            },
        );
        let next = observe_hook(
            first,
            HookSignal {
                event: "beforeSubmitPrompt".into(),
                at: 3,
                session_id: Some("s1".into()),
                prompt: Some("second".into()),
                ..HookSignal::default()
            },
        );
        assert_eq!(next.submit_prompt.as_deref(), Some("second"));
        assert_eq!(next.session_name, None);
    }

    #[test]
    fn hook_title_is_session_name() {
        let next = observe_hook(
            ProbeState::default(),
            HookSignal {
                event: "sessionStart".into(),
                at: 1,
                session_id: Some("s1".into()),
                title: Some("Ask Me".into()),
                prompt: Some("ignored".into()),
                ..HookSignal::default()
            },
        );
        assert_eq!(next.session_name.as_deref(), Some("Ask Me"));
        assert_eq!(next.submit_prompt, None);
    }

    #[test]
    fn cursor_resume_prompt_switches_identity() {
        let resumed = ProbeState {
            kind: Some("cursor".into()),
            state: "starting".into(),
            session_id: Some("c66a63c4-1cf6-467a-92b9-ee46fc9c47d3".into()),
            session_name: Some("Hello There".into()),
            first_prompt: Some("/resume".into()),
            ..ProbeState::default()
        };
        let next = observe_hook(
            resumed,
            HookSignal {
                kind: Some("cursor".into()),
                event: "beforeSubmitPrompt".into(),
                at: 2,
                session_id: Some("c6553b99-eef0-4d2a-af62-8deaa625f841".into()),
                prompt: Some("你好".into()),
                ..HookSignal::default()
            },
        );
        assert_eq!(next.state, "working");
        assert!(next.hook_seen);
        assert_eq!(
            next.session_id.as_deref(),
            Some("c6553b99-eef0-4d2a-af62-8deaa625f841")
        );
        assert_eq!(next.submit_prompt.as_deref(), Some("你好"));
    }

    #[test]
    fn cursor_prompt_binds_without_session_start() {
        let next = observe_hook(
            ProbeState {
                kind: Some("cursor".into()),
                state: "starting".into(),
                ..ProbeState::default()
            },
            HookSignal {
                kind: Some("cursor".into()),
                event: "beforeSubmitPrompt".into(),
                at: 1,
                session_id: Some("c6553b99-eef0-4d2a-af62-8deaa625f841".into()),
                prompt: Some("你好".into()),
                ..HookSignal::default()
            },
        );
        assert_eq!(next.state, "working");
        assert!(next.hook_seen);
        assert_eq!(
            next.session_id.as_deref(),
            Some("c6553b99-eef0-4d2a-af62-8deaa625f841")
        );
    }

    /// Antigravity has no permission event, so a tool start is held rather than
    /// raised: the TUI may or may not ask after the hook returns, and only silence
    /// longer than the window tells the two apart.
    #[test]
    fn antigravity_tool_start_holds_until_it_escalates() {
        let held = observe_hook(
            ProbeState {
                kind: Some("antigravity".into()),
                state: "working".into(),
                ..ProbeState::default()
            },
            HookSignal {
                kind: Some("antigravity".into()),
                event: "PreToolUse".into(),
                at: 2,
                tool: Some("run_command".into()),
                ..HookSignal::default()
            },
        );
        assert_eq!(held.state, "working");
        assert_eq!(held.held_attention_at, Some(2));
        assert_eq!(held.held_tool.as_deref(), Some("run_command"));
        // Inside the window the card is untouched, however often the poll runs.
        assert!(settle_held(held.clone(), 2 + HELD_ATTENTION_MS - 1).is_none());
        // A tool that answers retracts the guess, and it can never be promoted.
        let answered = observe_hook(
            held.clone(),
            HookSignal {
                kind: Some("antigravity".into()),
                event: "PostToolUse".into(),
                at: 3,
                tool: Some("run_command".into()),
                ..HookSignal::default()
            },
        );
        assert_eq!(answered.state, "working");
        assert_eq!(answered.held_attention_at, None);
        assert!(settle_held(answered, 3 + HELD_ATTENTION_MS).is_none());
        // Silence past the window means it was an ask after all.
        let raised = settle_held(held, 2 + HELD_ATTENTION_MS).expect("a held ask must promote");
        assert_eq!(raised.state, "attention");
        assert_eq!(raised.held_attention_at, None);
        assert_eq!(raised.at, 2 + HELD_ATTENTION_MS);
    }

    /// Antigravity pauses mid-turn with a `Stop` that is not fully idle. The turn is
    /// still running, so it is neither a turn end nor a reason to ignore what follows —
    /// and the ingress reports it as a fact instead of renaming the event.
    #[test]
    fn antigravity_paused_stop_is_not_a_turn_end() {
        let working = ProbeState {
            kind: Some("antigravity".into()),
            state: "working".into(),
            ..ProbeState::default()
        };
        let paused = observe_hook(
            working.clone(),
            HookSignal {
                kind: Some("antigravity".into()),
                event: "Stop".into(),
                at: 2,
                fully_idle: Some(false),
                ..HookSignal::default()
            },
        );
        assert_eq!(paused.state, "working");
        assert!(!paused.turn_completed);
        // A Stop that really ends the turn parks the card on the user.
        let ended = observe_hook(
            working,
            HookSignal {
                kind: Some("antigravity".into()),
                event: "Stop".into(),
                at: 3,
                fully_idle: Some(true),
                ..HookSignal::default()
            },
        );
        assert_eq!(ended.state, "attention");
        assert!(ended.turn_completed);
        // A straggler from that finished turn still cannot move it.
        let late = observe_hook(
            ended,
            HookSignal {
                kind: Some("antigravity".into()),
                event: "PreToolUse".into(),
                at: 4,
                ..HookSignal::default()
            },
        );
        assert_eq!(late.state, "attention");
    }

    /// `PermissionRequest` means one thing for every harness: the CLI is saying a prompt
    /// is already on screen, so it stays immediate. Antigravity included — nothing folds
    /// its tool gate into that name any more.
    #[test]
    fn a_reported_permission_request_is_still_immediate() {
        for kind in [
            "claude",
            "codebuddy",
            "codex",
            "opencode",
            "pi",
            "gemini",
            "grok",
            "antigravity",
        ] {
            let next = observe_hook(
                ProbeState {
                    kind: Some(kind.into()),
                    state: "working".into(),
                    ..ProbeState::default()
                },
                HookSignal {
                    kind: Some(kind.into()),
                    event: "PermissionRequest".into(),
                    at: 2,
                    ..HookSignal::default()
                },
            );
            assert_eq!(
                next.state, "attention",
                "{kind} must raise on its own permission event"
            );
            assert_eq!(next.held_attention_at, None, "{kind} has nothing to guess");
        }
    }

    /// Cursor answers its own permission hooks with `allow`, so its whole tool gate is
    /// a guess too — including the shell and MCP entries that used to be read as asks.
    #[test]
    fn cursor_tool_gate_holds_before_it_is_an_ask() {
        let start = observe_hook(
            ProbeState {
                kind: Some("cursor".into()),
                state: "working".into(),
                ..ProbeState::default()
            },
            HookSignal {
                kind: Some("cursor".into()),
                event: "preToolUse".into(),
                at: 2,
                tool: Some("Shell".into()),
                ..HookSignal::default()
            },
        );
        assert_eq!(start.state, "working");
        assert_eq!(start.held_attention_at, Some(2));

        let gate = observe_hook(
            ProbeState {
                kind: Some("cursor".into()),
                state: "working".into(),
                ..ProbeState::default()
            },
            HookSignal {
                kind: Some("cursor".into()),
                event: "beforeShellExecution".into(),
                at: 2,
                ..HookSignal::default()
            },
        );
        assert_eq!(gate.state, "working");
        assert_eq!(gate.held_attention_at, Some(2));

        let after = observe_hook(
            start.clone(),
            HookSignal {
                kind: Some("cursor".into()),
                event: "postToolUse".into(),
                at: 3,
                tool: Some("Shell".into()),
                ..HookSignal::default()
            },
        );
        assert_eq!(after.state, "working");
        assert_eq!(after.held_attention_at, None);

        let raised = settle_held(start, 2 + HELD_ATTENTION_MS).expect("a held ask must promote");
        assert_eq!(raised.state, "attention");
    }

    /// A title or a notification is the CLI's own report: once it has spoken, the guess
    /// has nothing left to promote, and re-raising it would fight the user.
    #[test]
    fn a_clear_report_settles_the_hold() {
        let held = observe_hook(
            ProbeState {
                kind: Some("cursor".into()),
                state: "working".into(),
                ..ProbeState::default()
            },
            HookSignal {
                kind: Some("cursor".into()),
                event: "preToolUse".into(),
                at: 2,
                ..HookSignal::default()
            },
        );
        let reported = observe_title(held, "attention", 3);
        assert_eq!(reported.state, "attention");
        assert!(settle_held(reported, 2 + HELD_ATTENTION_MS).is_none());
    }

    /// A turn that ends while a guess is held resolves it: the hook said something
    /// definite, so the guess must not come back to life a window later.
    #[test]
    fn a_definite_event_clears_the_hold() {
        let held = observe_hook(
            ProbeState {
                kind: Some("cursor".into()),
                state: "working".into(),
                ..ProbeState::default()
            },
            HookSignal {
                kind: Some("cursor".into()),
                event: "preToolUse".into(),
                at: 2,
                ..HookSignal::default()
            },
        );
        let stopped = observe_hook(
            held,
            HookSignal {
                kind: Some("cursor".into()),
                event: "stop".into(),
                at: 3,
                ..HookSignal::default()
            },
        );
        assert_eq!(stopped.state, "attention");
        assert_eq!(stopped.held_attention_at, None);
        assert!(settle_held(stopped.clone(), 3 + HELD_ATTENTION_MS).is_none());
        assert_eq!(stopped.at, 3, "the promotion must not restamp the turn end");
    }

    #[test]
    fn title_wins_even_after_hooks() {
        let current = ProbeState {
            state: "attention".into(),
            hook_seen: true,
            source: Some("hook".into()),
            ..ProbeState::default()
        };
        let next = observe_title(current, "working", 10);
        assert_eq!(next.state, "working");
        assert_eq!(next.title_state.as_deref(), Some("working"));
        assert_eq!(next.source.as_deref(), Some("title"));
    }

    #[test]
    fn title_exit_from_working_recovers_a_lost_stop_hook() {
        // The codex card stuck in "working": the Stop hook never arrived, only
        // the title probe saw the turn end. The title must still flip the card.
        let current = ProbeState {
            state: "working".into(),
            hook_seen: true,
            source: Some("hook".into()),
            ..ProbeState::default()
        };
        let next = observe_title(current, "attention", 10);
        assert_eq!(next.state, "attention");
    }
}
