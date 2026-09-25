//! The one registry every harness joins.
//!
//! A harness is a unit struct in `kinds/<id>.rs` implementing [`Harness`] — its launch
//! shape, its hook install, its event vocabulary, its session store and its quirks all
//! live in that one file. Everything the dispatch points used to hardcode (adapter
//! arrays, a `plan_for` match, the session `access` match, per-kind branches in the
//! installer, the external-ingress default map) reads from [`ALL`] instead, so adding a
//! harness means adding one file and one row here.
//!
//! Identity is a plain string at the edges (card `kind`, hook payloads), resolved
//! exactly once, here: [`find`] looks up a launchable kind, and [`ingress_key`] folds a
//! family member onto the settings key its install shares (`gemini` → `antigravity`,
//! `omp` → `pi`).

use super::debug::{HarnessDebugEvent, ProbeView};
pub use super::install::GlobalCtx;
use super::install::Host;
use super::label_text::SessionLabel;
use super::session_label::SessionFacts;
use super::signals::{default_meaning, HookSignal, Meaning};
use crate::error::{AppError, AppResult};
use crate::models::QueueWorkspace;
use std::collections::HashMap;
use std::future::Future;
use std::path::Path;
use std::pin::Pin;

/// Every launchable kind, and nothing else. Iterate this to reach all harnesses.
pub static ALL: &[&dyn Harness] = &[
    &super::kinds::claude::CLAUDE,
    &super::kinds::codebuddy::CODEBUDDY,
    &super::kinds::codex::CODEX,
    &super::kinds::cursor::CURSOR,
    &super::kinds::devin::DEVIN,
    &super::kinds::antigravity::ANTIGRAVITY,
    &super::kinds::antigravity::GEMINI,
    &super::kinds::grok::GROK,
    &super::kinds::opencode::OPENCODE,
    &super::kinds::pi::PI,
    &super::kinds::pi::OMP,
    &super::kinds::shell::SHELL,
];

/// A kind the registry knows nothing about still has to be observed without panic —
/// hook payloads are external input, and an unknown name must behave exactly as it did
/// before it existed: generic vocabulary, no guesses, no session store.
static UNKNOWN: unknown::Unknown = unknown::Unknown;

mod unknown {
    use super::Harness;

    pub struct Unknown;

    impl Harness for Unknown {
        fn id(&self) -> &'static str {
            "unknown"
        }
    }
}

/// The launchable harness a kind string names, or `None` for anything else.
pub fn builtin(kind: &str) -> Option<&'static dyn Harness> {
    ALL.iter().copied().find(|harness| harness.id() == kind)
}

pub fn find(kind: &str) -> Option<&'static dyn Harness> {
    builtin(kind).or_else(|| super::extensions::find(kind).map(|h| h as &dyn Harness))
}

/// Like [`find`], but never fails: an unknown kind observes through [`UNKNOWN`].
pub fn resolve(kind: &str) -> &'static dyn Harness {
    find(kind).unwrap_or(&UNKNOWN)
}

/// One harness's launch shape: what to run, and how to ask it to resume a session.
pub struct Adapter {
    pub executable: &'static str,
    pub args: &'static [&'static str],
    resume: fn(&str) -> AppResult<Vec<String>>,
}

impl Adapter {
    pub(crate) fn new(
        executable: &'static str,
        args: &'static [&'static str],
        resume: fn(&str) -> AppResult<Vec<String>>,
    ) -> Self {
        Self {
            executable,
            args,
            resume,
        }
    }

    pub fn resume_args(&self, session_id: &str) -> AppResult<Vec<String>> {
        (self.resume)(session_id)
    }
}

/// Every harness resumes by handing a session id back on the command line, so the id is
/// checked once, here, before any harness sees it.
pub(super) fn checked_id(session_id: &str) -> AppResult<&str> {
    if !regex::Regex::new(r"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$")
        .unwrap()
        .is_match(session_id)
    {
        return Err(AppError::machine("HARNESS_SESSION_ID_INVALID"));
    }
    Ok(session_id)
}

/// `--resume <id>`: what every harness without a rule of its own uses.
pub(super) fn resume_flag(session_id: &str) -> AppResult<Vec<String>> {
    Ok(vec!["--resume".into(), checked_id(session_id)?.into()])
}

/// Everything a harness module may look at while describing its hook install.
pub struct Ctx<'a> {
    pub version: &'a str,
    pub kind: &'a str,
    pub workspace: &'a QueueWorkspace,
    pub host: &'a Host,
    /// Where the ingress scripts are read from: a harness that needs its own looks
    /// for it here.
    pub bin_dir: &'a Path,
}

/// What one harness wants written, launched and merged.
#[derive(Default)]
pub struct Plan {
    /// Files under the plugin root, by relative name.
    pub files: HashMap<String, String>,
    /// Extra argv the CLI has to be launched with.
    pub args: Vec<String>,
    /// Extra environment the CLI has to see.
    pub env: HashMap<String, String>,
    /// User-level config files this harness merges into instead of owning.
    pub user_config: Vec<UserMerge>,
}

/// A user-level config file this harness merges into instead of owning.
///
/// The three shapes in use (Grok's marked copy, Antigravity's guarded key, Cursor's
/// shared hooks array) all reduce to: read what is there, produce the new text — or, on
/// a remote host, run one script that does the same over SSH.
pub struct UserMerge {
    /// Absolute path of the file (remote: home-anchored, as the CLI sees it).
    pub path: String,
    /// The file under the plugin root carrying this harness's payload.
    pub payload: &'static str,
    /// Local install: the file's current text (`None` when absent) and the payload
    /// become the new text. Refusing to touch a file Que does not own is the merge's
    /// job, not the installer's.
    pub local: fn(existing: Option<&str>, payload: &str, host: &Host) -> AppResult<String>,
    /// Remote install: a `node -e` script plus the argv that follows it.
    pub remote: Option<(
        &'static str,
        fn(host: &Host, path: &str, payload: &str) -> Vec<String>,
    )>,
}

/// A version floor checked synchronously at launch: a CLI that cannot report the
/// feature the hooks rely on fails the card instead of starting blind.
pub struct VersionGate {
    /// The version floor the CLI has to report, shown to the user when the gate fails.
    pub min: &'static str,
    allows: fn(&str) -> bool,
}

impl VersionGate {
    pub(crate) fn new(min: &'static str, allows: fn(&str) -> bool) -> Self {
        Self { min, allows }
    }

    pub fn allows(&self, version: &str) -> bool {
        (self.allows)(version)
    }
}

/// Per-harness launch quirks the generic pipeline reads instead of hardcoding.
#[derive(Clone, Copy, Default)]
pub struct LaunchTweaks {
    /// Pin the canvas dark regardless of the app theme (Grok paints its own).
    pub dark_canvas: bool,
    /// Fake a Kitty environment so the CLI picks the notification channel Que reads.
    pub kitty_notifications: bool,
    /// Windows: launch node on the CLI's script directly, skipping the `.cmd` shim.
    pub windows_direct_launch: bool,
    /// Variables to strip from the remote login line before the CLI starts.
    pub ssh_unset: &'static [&'static str],
}

/// The hook deadline the CLI is told about, in seconds. On Windows every hook
/// pays a PowerShell + node process startup (seconds, cold start with Defender
/// even more), so short deadlines turn into "hook timed out" on real sessions —
/// the same reason Cursor runs 15s.
pub fn default_hook_timeout(windows_local: bool) -> u32 {
    if windows_local {
        15
    } else {
        2
    }
}

/// Everything Que knows about one harness, in one place.
pub trait Harness: Sync {
    /// The canonical kind string: what cards carry and what `find` looks up.
    fn id(&self) -> &'static str;
    /// The settings key this harness's external ingress is toggled under. Family
    /// members that share an install share a key (`gemini` → `antigravity`).
    fn ingress_key(&self) -> &'static str {
        self.id()
    }

    // —— launch ——
    /// What to run and how to resume. `None` means no CLI at all: a shell card whose
    /// state comes off the PTY.
    fn adapter(&self) -> Option<Adapter> {
        None
    }
    fn version_flag(&self) -> &'static str {
        "--version"
    }
    fn version_gate(&self) -> Option<VersionGate> {
        None
    }
    fn launch_tweaks(&self) -> LaunchTweaks {
        LaunchTweaks::default()
    }
    /// Extra directories a CLI of this kind may hide in, under the user's home.
    fn extra_search_dirs(&self) -> &'static [&'static str] {
        &[]
    }

    // —— install ——
    /// Describe the per-card hook install. Async because a plan may have to read the
    /// CLI's existing (possibly remote) config first. The default empty plan is never
    /// consulted: a harness without an adapter never reaches the hook installer.
    fn plan<'a>(
        &'a self,
        _ctx: Ctx<'a>,
    ) -> Pin<Box<dyn Future<Output = AppResult<Plan>> + Send + 'a>> {
        Box::pin(async { Ok(Plan::default()) })
    }
    /// The user-level install serving sessions Que never launched. Default: none.
    fn global(&self, _ctx: &GlobalCtx) {}
    /// Undo `global` — the settings toggle's other half, so switching a kind off
    /// leaves no Que entries behind in the CLI's own config. Only the entries
    /// `global` wrote are removed; user-written hooks stay. Kinds whose config
    /// shape makes a clean removal awkward may leave this a no-op and document
    /// the leftovers.
    fn unglobal(&self, _ctx: &GlobalCtx) {}

    /// Where the plugin root lands on a remote host.
    fn remote_root(&self, home: &str, token: &str, _ingress_sha: &str) -> String {
        format!("{home}/.cache/que/harness/{token}")
    }
    /// The hook deadline the CLI is told about, in seconds.
    fn hook_timeout(&self, windows_local: bool) -> u32 {
        default_hook_timeout(windows_local)
    }
    /// How a hook of this kind is invoked on the machine it is installed on.
    fn hook_command(&self, host: &Host, event: Option<&str>) -> String {
        host.generic_hook_command(event)
    }
    /// Where a remote card's hook signals land, when it is not the launcher's sink.
    fn remote_signal_dir(&self, _host: &Host) -> Option<String> {
        None
    }

    // —— hook events ——
    /// The events this harness is asked to report.
    fn events(&self) -> &'static [&'static str] {
        &[]
    }
    /// What one of this harness's hook events means for a card. The shared vocabulary
    /// covers every harness; only a genuinely alien one overrides this.
    fn meaning(&self, signal: &HookSignal) -> Meaning {
        default_meaning(signal, self.guesses_attention(signal))
    }
    /// A tool start whose gate the CLI owns: the ask is a guess, held for a window
    /// instead of raised. Claude-family CLIs are deliberately absent — their real ask
    /// arrives as its own event.
    fn guesses_attention(&self, _signal: &HookSignal) -> bool {
        false
    }
    /// Stragglers filed after a completed turn cannot move the card, so the two turn
    /// boundaries have to be told apart from the states this harness also reports.
    fn suppresses_stragglers(&self) -> bool {
        false
    }
    /// Whether the terminal-stream notification probes are wired for this harness.
    fn notify_probe(&self) -> bool {
        true
    }
    /// Whether the TUI title probe is wired (Codex's plan/approval titles).
    fn title_probe(&self) -> bool {
        false
    }

    // —— sessions ——
    /// Whether a session is still on disk. `None` when this harness cannot answer.
    fn session_exists(&self, _id: &str) -> Option<bool> {
        None
    }
    /// What to call a session, and its first prompt when the store has one.
    fn session_label(&self, _id: &str, _need_first_prompt: bool) -> Option<SessionLabel> {
        None
    }
    /// What the session's own store knows, when it records a conversation.
    fn session_details(&self, _id: &str) -> Option<SessionFacts> {
        None
    }
    /// What a notice shows. A store with no transcript still names its session.
    fn session_facts(&self, id: &str) -> SessionFacts {
        self.session_details(id)
            .or_else(|| {
                self.session_label(id, true).map(|label| SessionFacts {
                    name: label.name,
                    prompt: label.first_prompt,
                    ..SessionFacts::default()
                })
            })
            .unwrap_or_default()
    }
    /// Whether a live card's probe may be renamed from this harness's session files.
    fn refresh_probe_label(&self) -> bool {
        true
    }
    /// Resolve a truncated session id shown in the TUI title to a full one. The
    /// prefix only ever comes from a title probe, so `None` (the default) is never
    /// consulted for a harness that has none.
    fn resolve_session_prefix(&self, _prefix: &str) -> Option<String> {
        None
    }
    /// The session id a dead CLI left in its terminal footer, if it prints one. The
    /// reader closure is lazy: a harness without a footer never pays for the read.
    fn exit_session_id(&self, _read_output: &dyn Fn() -> Option<String>) -> Option<String> {
        None
    }

    // —— debug ——
    /// Harness-private heuristics appended to the debug overlay's clues.
    fn debug_clues(
        &self,
        _probe: Option<&ProbeView>,
        _pty: Option<&crate::terminal::PtyProbe>,
        _events: &[HarnessDebugEvent],
        _out: &mut Vec<String>,
    ) {
    }

    // —— external ingress ——
    /// Whether this harness serves sessions Que never launched under its own settings
    /// key. Family members covered by their host's key are `false`.
    fn external_ingress(&self) -> bool {
        false
    }
}
