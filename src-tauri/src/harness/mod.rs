mod debug;
mod env;
mod external;
mod hooks;
mod inherited;
mod install;
pub(crate) mod kinds;
mod label_text;
mod notify_osc;
mod osc;
pub(crate) mod registry;
mod session_find;
mod session_label;
mod signals;
mod windows;

use crate::winproc::NoWindow;

pub use debug::HarnessDebugSnapshot;
pub use env::local_environment;
pub use external::ExternalRuntime;
pub use hooks::{prepare_hook_launch, sync_external_hooks, sync_installed_hooks};
pub use osc::HookOscProbe;
pub use session_label::session_exists;
pub use signals::{observe_hook, observe_title, settle_held, HookSignal, ProbeState};
pub use windows::windows_command;

use crate::error::{AppError, AppResult};
use crate::live::LiveBus;
use crate::models::{HarnessSession, QueueWorkspace};
use crate::paths::signal_dir;
use crate::settings::SettingsStore;
use crate::ssh::{ssh_login_command, ssh_login_exec};
use crate::terminal::{Spawn, TerminalHub};
use crate::transcript::read_terminal_transcript;
use kinds::shell::prepare_shell;
use notify_osc::{notify_osc_kinds, observe_notify, prefer_kitty_notifications, KittyNotifyProbe};
use parking_lot::Mutex;
use registry::{find, LaunchTweaks};
use session_label::refresh_probe_label;
use std::collections::HashMap;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use uuid::Uuid;

#[derive(Clone)]
pub struct HarnessRuntime {
    probes: Arc<Mutex<HashMap<String, ProbeState>>>,
    debug: Arc<debug::DebugLog>,
    live: LiveBus,
    /// terminal_id -> CLI version reported by the deferred `--version` probe.
    /// The probe no longer sits on the connect path (a PowerShell-backed shim
    /// costs seconds), so the snapshot overlays the answer once it lands.
    versions: Arc<Mutex<HashMap<String, String>>>,
}

impl HarnessRuntime {
    pub fn new(live: LiveBus, terminals: TerminalHub) -> Self {
        let probes = Arc::new(Mutex::new(HashMap::new()));
        let debug = Arc::new(Mutex::new(HashMap::new()));
        start_signal_watch(probes.clone(), debug.clone(), terminals, live.clone());
        Self {
            probes,
            debug,
            live,
            versions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn debug_snapshot(
        &self,
        terminal_id: &str,
        terminals: &TerminalHub,
    ) -> HarnessDebugSnapshot {
        apply_file_signals(&self.probes, &self.debug, terminals, terminal_id);
        debug::snapshot(&self.debug, &self.probes, terminals, terminal_id)
    }

    pub fn snapshot(&self, session: &HarnessSession, terminals: &TerminalHub) -> HarnessSession {
        let harness = find(&session.kind);
        // A harness without an adapter is a shell card: its state comes off the PTY.
        let shell_card = harness.is_some_and(|h| h.adapter().is_none());
        let mut current = self.probes.lock().get(&session.terminal_id).cloned();
        if current.is_some() {
            apply_file_signals(&self.probes, &self.debug, terminals, &session.terminal_id);
            current = self.probes.lock().get(&session.terminal_id).cloned();
        }
        let mut provider_session_id = current
            .as_ref()
            .and_then(|c| c.session_id.clone())
            .or_else(|| session.provider_session_id.clone());
        // A truncated session id in the TUI title only ever comes from a harness whose
        // title probe reports one; it resolves through that harness's own store.
        if let Some(prefix) = current
            .as_ref()
            .and_then(|c| c.session_id_prefix.as_deref())
        {
            let prefix = prefix.to_lowercase();
            provider_session_id = if session.remote == Some(true) {
                provider_session_id.filter(|id| id.to_lowercase().starts_with(&prefix))
            } else {
                harness.and_then(|h| h.resolve_session_prefix(&prefix))
            };
        }
        let terminal = terminals.snapshot(&session.terminal_id);
        let dead = terminal.as_ref().is_none_or(|t| t.exited);
        let mut unpersisted_session = None;
        if dead && session.remote != Some(true) {
            // The session id a dead CLI left in its terminal footer: the read is lazy,
            // so a harness without a footer never pays for it.
            if let Some(footer_id) = harness.and_then(|h| {
                h.exit_session_id(&|| {
                    terminal.as_ref().map(|t| t.output.clone()).or_else(|| {
                        read_terminal_transcript(&session.terminal_id).map(|saved| saved.output)
                    })
                })
            }) {
                let persisted = session_exists(&session.kind, &footer_id);
                provider_session_id = if persisted == Some(true) {
                    Some(footer_id)
                } else {
                    None
                };
                unpersisted_session = Some(persisted == Some(false));
            }
            if let Some(id) = provider_session_id.as_deref() {
                if session_exists(&session.kind, id) == Some(false) {
                    provider_session_id = None;
                    unpersisted_session = Some(true);
                }
            }
        }
        let session_name = current
            .as_ref()
            .and_then(|c| c.session_name.clone())
            .or_else(|| session.session_name.clone());
        let first_prompt = current
            .as_ref()
            .and_then(|c| c.first_prompt.clone())
            .or_else(|| session.first_prompt.clone());
        let submit_prompt = current
            .as_ref()
            .and_then(|c| c.submit_prompt.clone())
            .or_else(|| session.submit_prompt.clone());
        let shell_notify = shell_card
            && session.shell_notify == Some(true)
            && session.shell_command_started_at
                == current.as_ref().and_then(|c| c.shell_command_started_at);
        let state = match &terminal {
            None => "error".into(),
            Some(t) if t.exited => "exited".into(),
            Some(_) if shell_card => {
                if shell_notify
                    && current.as_ref().and_then(|c| c.shell_command_running) == Some(true)
                {
                    "working".into()
                } else {
                    "attention".into()
                }
            }
            Some(_) => current
                .as_ref()
                .map(|c| c.state.clone())
                .unwrap_or_else(|| "unknown".into()),
        };
        let mut next = session.clone();
        if shell_card {
            next.shell_command_started_at =
                current.as_ref().and_then(|c| c.shell_command_started_at);
            next.shell_command_running = current.as_ref().and_then(|c| c.shell_command_running);
            next.shell_exit_code = current.as_ref().and_then(|c| c.shell_exit_code);
            next.shell_notify = Some(shell_notify);
        }
        next.state = state;
        if let Some(found) = self.versions.lock().get(&session.terminal_id).cloned() {
            if !found.is_empty() {
                next.version = found;
            }
        }
        next.provider_session_id = provider_session_id.clone();
        next.unpersisted_session = unpersisted_session;
        next.reply_preview = current.as_ref().and_then(|c| c.reply_preview.clone());
        next.session_name = session_name;
        next.first_prompt = first_prompt;
        next.submit_prompt = submit_prompt;
        next.title = None;
        next.source = current.as_ref().and_then(|c| c.source.clone());
        next.probe = Some(match current.as_ref() {
            Some(c) if c.hook_seen && c.title_seen => "hooks-and-title".into(),
            Some(c) if c.hook_seen => "hooks".into(),
            Some(c) if c.title_seen => "title-only".into(),
            _ => "unconfirmed".into(),
        });
        if let Some(code) = terminal.as_ref().and_then(|t| t.exit_code) {
            next.exit_code = Some(code);
        }
        next
    }

    pub async fn launch(
        &self,
        card_id: &str,
        kind: &str,
        workspace: &QueueWorkspace,
        resume: Option<HarnessSession>,
        terminals: &TerminalHub,
        settings: &SettingsStore,
        bin_dir: &std::path::Path,
        use_tmux: bool,
    ) -> AppResult<HarnessSession> {
        let launch_started = std::time::Instant::now();
        let harness = find(kind).ok_or_else(|| AppError::machine("HARNESS_UNSUPPORTED"))?;
        let terminal_id = Uuid::new_v4().simple().to_string();
        let mark = |stage: &str| {
            crate::debuglog::info_term(
                "harness",
                &terminal_id,
                &format!(
                    "startup stage={stage} elapsed_ms={} kind={kind}",
                    launch_started.elapsed().as_millis()
                ),
            )
        };
        mark("begin");
        let signals = signal_dir(&terminal_id);
        if resume
            .as_ref()
            .is_some_and(|s| s.provider_session_id.is_none())
        {
            return Err(AppError::machine("HARNESS_RESUME_NO_ID"));
        }
        let mut version = String::new();
        let mut env = HashMap::new();
        let mut shell_notifications = false;
        // Filled in by whichever branch below applies. Remote sessions hand the
        // whole login line to the SSH channel; local ones still need a pty.
        let spawn;
        // A harness without an adapter runs no CLI: a shell card whose state comes
        // off the PTY.
        let shell_card = harness.adapter().is_none();

        // A remote card execs the CLI on the host; a missing binary only surfaces as
        // `exec: …: not found` inside the opened card, after launch has succeeded.
        // Probe once, through the same login shell the card will use, and fail before
        // anything opens.
        if !shell_card && workspace.kind == "ssh" {
            let host = workspace
                .ssh_host
                .as_deref()
                .ok_or_else(|| AppError::machine("WORKSPACE_MISSING"))?;
            let executable = harness.adapter().expect("checked above").executable;
            let found = String::from_utf8_lossy(
                &ssh_login_exec(host, &crate::ssh::ssh_cli_probe(executable)).await?,
            )
            .trim()
            .to_string();
            if !found.starts_with('/') {
                return Err(AppError::machine_detail(
                    "HARNESS_CLI_MISSING_REMOTE",
                    executable,
                ));
            }
        }

        if workspace.kind == "ssh" && use_tmux {
            let host = workspace
                .ssh_host
                .as_deref()
                .ok_or_else(|| AppError::machine("WORKSPACE_MISSING"))?;
            let found = String::from_utf8_lossy(
                &ssh_login_exec(host, &crate::ssh::ssh_cli_probe("tmux")).await?,
            )
            .trim()
            .to_string();
            if !found.starts_with('/') {
                return Err(AppError::machine_detail(
                    "HARNESS_CLI_MISSING_REMOTE",
                    "tmux",
                ));
            }
        }

        if shell_card {
            let shell = prepare_shell(
                workspace,
                card_id,
                &signals,
                bin_dir,
                settings.read()?.powershell_enabled,
                use_tmux,
            )
            .await?;
            spawn = shell.spawn;
            version = shell.version;
            shell_notifications = shell.command_notifications;
        } else {
            let adapter = harness.adapter().expect("checked above");
            let mut command_path = adapter.executable.to_string();
            let mut command_prefix: Vec<String> = Vec::new();
            let tweaks: LaunchTweaks = harness.launch_tweaks();
            if workspace.kind == "local" {
                let mut local = local_environment(false).await.unwrap_or_default();
                let extra_dirs: Vec<std::path::PathBuf> = crate::paths::user_home()
                    .map(|home| {
                        harness
                            .extra_search_dirs()
                            .iter()
                            .map(|dir| home.join(dir))
                            .collect()
                    })
                    .unwrap_or_default();
                if let Some(resolved) =
                    env::resolve_local_command(&adapter.executable, &local, &extra_dirs)
                {
                    command_path = resolved;
                    env = local;
                } else {
                    local = local_environment(true).await.unwrap_or_default();
                    if let Some(resolved) =
                        env::resolve_local_command(&adapter.executable, &local, &extra_dirs)
                    {
                        command_path = resolved;
                        env = local;
                    } else {
                        return Err(AppError::machine_detail(
                            "HARNESS_CLI_MISSING",
                            adapter.executable,
                        ));
                    }
                }
                // cursor-agent.cmd wraps cmd → powershell → node; the bootstrap only
                // picks versions\<latest>\index.js, so launch node on it directly and
                // skip two interpreter startups. Any mismatch falls back to the shim.
                if tweaks.windows_direct_launch {
                    if let Some(direct) = kinds::cursor::direct_node_launch(&command_path) {
                        command_path = direct.node;
                        command_prefix = vec![direct.script];
                        for (key, value) in direct.env {
                            if !env.keys().any(|k| k.eq_ignore_ascii_case(&key)) {
                                env.insert(key, value);
                            }
                        }
                    }
                }
                if cfg!(windows) && kind == "codex" {
                    if let Some(script) = kinds::codex::npm_entrypoint(&command_path) {
                        let bundled_node = std::path::Path::new(&command_path)
                            .parent()
                            .unwrap()
                            .join("node.exe");
                        let node = if bundled_node.is_file() {
                            Some(bundled_node.to_string_lossy().into_owned())
                        } else {
                            env::resolve_local_command("node", &env, &[])
                        };
                        if let Some(node) = node {
                            command_path = node;
                            command_prefix = vec![script.to_string_lossy().into_owned()];
                        }
                    }
                }
            }
            // Most probes are display-only; OpenCode selects its plugin API here.
            mark("environment-and-command-ready");
            // keep it off the connect path — a shim probe through cmd/PowerShell
            // costs seconds — and publish the answer via the snapshot overlay.
            if kind == "opencode" {
                // V1 server hooks and V2 CLI plugins have incompatible entrypoints.
                version = detect_version(
                    workspace,
                    &command_path,
                    &command_prefix,
                    harness.version_flag(),
                    &env,
                )
                .await?;
            } else if let Some(gate) = harness.version_gate() {
                version = detect_version(
                    workspace,
                    &command_path,
                    &command_prefix,
                    harness.version_flag(),
                    &env,
                )
                .await?;
                if !gate.allows(&version) {
                    return Err(AppError::machine_detail(
                        "HARNESS_VERSION_TOO_OLD",
                        gate.min,
                    ));
                }
            } else {
                let probe_workspace = workspace.clone();
                let probe_command = command_path.clone();
                let probe_prefix = command_prefix.clone();
                let probe_env = env.clone();
                let probe_flag = harness.version_flag();
                let probe_versions = self.versions.clone();
                let probe_debug = self.debug.clone();
                let probe_live = self.live.clone();
                let probe_terminal = terminal_id.clone();
                tokio::spawn(async move {
                    match detect_version(
                        &probe_workspace,
                        &probe_command,
                        &probe_prefix,
                        probe_flag,
                        &probe_env,
                    )
                    .await
                    {
                        Ok(found) => {
                            debug::record(
                                &probe_debug,
                                &probe_terminal,
                                debug::HarnessDebugEvent {
                                    at: now_ms(),
                                    source: "probe".into(),
                                    event: "version".into(),
                                    state: String::new(),
                                    session_id: None,
                                    prompt: Some(found.clone()),
                                    note: None,
                                },
                            );
                            if !found.is_empty() {
                                probe_versions.lock().insert(probe_terminal, found);
                                probe_live.notify("queue");
                            }
                        }
                        Err(error) => {
                            crate::debuglog::log_error(
                                &format!("harness version probe term={probe_terminal}"),
                                &error,
                            );
                        }
                    }
                });
            }
            mark("hooks-begin");
            let hooks = match prepare_hook_launch(
                kind,
                &signals,
                workspace,
                &terminal_id,
                bin_dir,
                &version,
            )
            .await
            {
                Ok(hooks) => {
                    crate::debuglog::info_term(
                        "harness",
                        &terminal_id,
                        &format!("hooks installed kind={kind}"),
                    );
                    hooks
                }
                Err(error) => {
                    crate::debuglog::log_error(
                        &format!("harness hook install kind={kind}"),
                        &error,
                    );
                    return Err(error);
                }
            };
            env.extend(hooks.env);
            mark("hooks-ready");
            let canvas_dark = tweaks.dark_canvas || crate::terminal_theme::app_dark();
            env.insert(
                "COLORFGBG".into(),
                crate::terminal_theme::colorfgbg(canvas_dark).into(),
            );
            env.insert("COLORTERM".into(), "truecolor".into());
            if tweaks.kitty_notifications {
                prefer_kitty_notifications(&mut env);
            }
            if let Some(session_id) = resume.as_ref().and_then(|s| s.provider_session_id.clone()) {
                env.insert("QUE_HARNESS_SESSION_ID".into(), session_id);
            }
            let mut launch_args = command_prefix;
            if let Some(session_id) = resume
                .as_ref()
                .and_then(|s| s.provider_session_id.as_deref())
            {
                launch_args.extend(adapter.resume_args(session_id)?);
            }
            launch_args.extend(adapter.args.iter().map(|s| s.to_string()));
            launch_args.extend(hooks.args);
            if workspace.kind == "ssh" {
                let host = workspace
                    .ssh_host
                    .as_deref()
                    .ok_or_else(|| AppError::machine("WORKSPACE_MISSING"))?;
                let exports = env
                    .iter()
                    .map(|(k, v)| format!("{k}={}", crate::ssh::shell_quote(v)))
                    .collect::<Vec<_>>()
                    .join(" ");
                let command = std::iter::once(adapter.executable.to_string())
                    .chain(launch_args)
                    .map(|s| crate::ssh::shell_quote(&s))
                    .collect::<Vec<_>>()
                    .join(" ");
                let unset = tweaks
                    .ssh_unset
                    .iter()
                    .map(|name| format!("unset {name} && "))
                    .collect::<String>();
                let remote = if use_tmux {
                    let inner_exec = format!(
                        "{}QUE_HARNESS_TTY=$(tty) && export QUE_HARNESS_TTY && exec {}",
                        if exports.is_empty() {
                            String::new()
                        } else {
                            format!("export {exports} && ")
                        },
                        command
                    );
                    let term_id = crate::ssh::card_tmux_session_id(card_id);
                    let wrapped = crate::ssh::wrap_remote_tmux_with_channel(
                        &term_id,
                        &workspace.cwd,
                        &inner_exec,
                        Some(&terminal_id),
                    );
                    format!(
                        "cd {} && {}{}",
                        crate::ssh::shell_quote(&workspace.cwd),
                        unset,
                        wrapped
                    )
                } else {
                    format!(
                        "cd {} && {}{}QUE_HARNESS_TTY=$(tty) && export QUE_HARNESS_TTY && exec {}",
                        crate::ssh::shell_quote(&workspace.cwd),
                        unset,
                        if exports.is_empty() {
                            String::new()
                        } else {
                            format!("export {exports} && ")
                        },
                        command
                    )
                };
                spawn = Spawn::Remote {
                    host: host.to_string(),
                    command: ssh_login_command(&remote),
                };
            } else if cfg!(windows) {
                let launch = windows_command(&command_path, &launch_args);
                spawn = Spawn::Local {
                    executable: launch.executable,
                    args: launch.args,
                    env,
                };
            } else {
                spawn = Spawn::Local {
                    executable: command_path,
                    args: launch_args,
                    env,
                };
            }
        }

        crate::debuglog::info_term(
            "harness",
            &terminal_id,
            &format!(
                "launch kind={kind} workspace={} spawn={}",
                workspace.kind,
                match &spawn {
                    Spawn::Local { .. } => "local",
                    Spawn::Remote { host, .. } => host,
                }
            ),
        );
        self.probes.lock().insert(
            terminal_id.clone(),
            ProbeState {
                kind: Some(kind.to_string()),
                remote: workspace.kind == "ssh",
                state: if shell_card {
                    "attention".into()
                } else {
                    "starting".into()
                },
                at: now_ms(),
                session_id: resume.as_ref().and_then(|s| s.provider_session_id.clone()),
                session_name: resume.as_ref().and_then(|s| s.session_name.clone()),
                first_prompt: resume.as_ref().and_then(|s| s.first_prompt.clone()),
                submit_prompt: resume.as_ref().and_then(|s| s.submit_prompt.clone()),
                // The spawn clock, so the signal path can report `spawn -> first hook`
                // without reaching into the PTY probe. Stamped a few ms before the
                // actual spawn; that error is far below the effect we are chasing.
                spawned_at_ms: Some(now_ms()),
                ..ProbeState::default()
            },
        );
        let osc = Arc::new(std::sync::Mutex::new(HookOscProbe::new(
            terminal_id.clone(),
        )));
        let notify = if harness.notify_probe() {
            Some(Arc::new(std::sync::Mutex::new(KittyNotifyProbe::new())))
        } else {
            None
        };
        let title_probe = if harness.title_probe() {
            Some(Arc::new(std::sync::Mutex::new(
                kinds::codex::CodexTitleProbe::new(),
            )))
        } else {
            None
        };
        let probes = self.probes.clone();
        let debug_log = self.debug.clone();
        let live = self.live.clone();
        let id_cb = terminal_id.clone();
        // The per-kind branches the closure used to read off the kind string, decided
        // once here from the harness definition.
        let track_notify_kinds = !shell_card;
        let process_hook_osc = !shell_card;
        let track_shell_commands = shell_card && shell_notifications;
        let on_output: Arc<dyn Fn(&str) + Send + Sync> = Arc::new(move |data: &str| {
            if track_notify_kinds {
                for kind in notify_osc_kinds(data) {
                    let mut map = probes.lock();
                    if let Some(current) = map.get_mut(&id_cb) {
                        current.notify_osc_hits = current.notify_osc_hits.saturating_add(1);
                        let first = !current.notify_osc_seen.iter().any(|seen| seen == kind);
                        if first {
                            current.notify_osc_seen.push(kind.to_string());
                        }
                        debug::record(
                            &debug_log,
                            &id_cb,
                            debug::HarnessDebugEvent {
                                at: now_ms(),
                                source: "notify-osc".into(),
                                event: kind.into(),
                                state: current.state.clone(),
                                session_id: current.session_id.clone(),
                                prompt: None,
                                note: Some(if first {
                                    "seen-in-stream".into()
                                } else {
                                    format!("seen-in-stream#{}", current.notify_osc_hits)
                                }),
                            },
                        );
                    }
                }
            }
            if process_hook_osc {
                let hook_ok = catch_unwind(AssertUnwindSafe(|| {
                    if let Ok(mut osc) = osc.lock() {
                        let mut incoming = data;
                        while let Some(signal) = osc.push(incoming) {
                            incoming = "";
                            let mut map = probes.lock();
                            if let Some(current) = map.get(&id_cb).cloned() {
                                let mut next = observe_hook(current.clone(), signal.clone());
                                refresh_probe_label(&mut next);
                                debug::record(
                                    &debug_log,
                                    &id_cb,
                                    debug::HarnessDebugEvent {
                                        at: signal.at,
                                        source: "osc".into(),
                                        event: signal.event.clone(),
                                        state: next.state.clone(),
                                        session_id: signal.session_id.clone(),
                                        prompt: signal.prompt.clone(),
                                        note: None,
                                    },
                                );
                                let changed = next.state != current.state
                                    || next.hook_seen != current.hook_seen
                                    || next.session_name != current.session_name
                                    || next.first_prompt != current.first_prompt
                                    || next.submit_prompt != current.submit_prompt;
                                note_state(
                                    &id_cb,
                                    "osc",
                                    &signal.event,
                                    &current.state,
                                    &next.state,
                                );
                                map.insert(id_cb.clone(), next);
                                if changed {
                                    live.notify("hook");
                                }
                            }
                        }
                    }
                }));
                if hook_ok.is_err() {
                    debug::record(
                        &debug_log,
                        &id_cb,
                        debug::HarnessDebugEvent {
                            at: now_ms(),
                            source: "probe".into(),
                            event: "panic".into(),
                            state: String::new(),
                            session_id: None,
                            prompt: None,
                            note: Some("hook-osc".into()),
                        },
                    );
                }
            }
            if let Some(notify) = &notify {
                let notify_ok = catch_unwind(AssertUnwindSafe(|| {
                    if let Ok(mut notify) = notify.lock() {
                        if let Some(signal) = notify.push(data) {
                            let mut map = probes.lock();
                            if let Some(current) = map.get(&id_cb).cloned() {
                                let next = observe_notify(current.clone(), &signal, now_ms());
                                debug::record(
                                    &debug_log,
                                    &id_cb,
                                    debug::HarnessDebugEvent {
                                        at: now_ms(),
                                        source: "notify-osc".into(),
                                        event: "Notification".into(),
                                        state: next.state.clone(),
                                        session_id: current.session_id.clone(),
                                        prompt: signal.body.clone(),
                                        note: Some(signal.id),
                                    },
                                );
                                let changed = next.state != current.state
                                    || next.reply_preview != current.reply_preview;
                                note_state(
                                    &id_cb,
                                    "notify-osc",
                                    "Notification",
                                    &current.state,
                                    &next.state,
                                );
                                map.insert(id_cb.clone(), next);
                                if changed {
                                    live.notify("hook");
                                }
                            }
                        }
                    }
                }));
                if notify_ok.is_err() {
                    debug::record(
                        &debug_log,
                        &id_cb,
                        debug::HarnessDebugEvent {
                            at: now_ms(),
                            source: "probe".into(),
                            event: "panic".into(),
                            state: String::new(),
                            session_id: None,
                            prompt: None,
                            note: Some("notify-osc".into()),
                        },
                    );
                }
            }
            if let Some(probe) = &title_probe {
                if let Ok(mut probe) = probe.lock() {
                    let state = probe.push(data);
                    let needs_input = probe.consume_needs_input();
                    if state.is_some() || needs_input {
                        let mut map = probes.lock();
                        if let Some(current) = map.get(&id_cb).cloned() {
                            let raised = if needs_input {
                                observe_hook(
                                    current.clone(),
                                    HookSignal {
                                        event: "PermissionRequest".into(),
                                        at: now_ms(),
                                        session_id: current.session_id.clone(),
                                        ..Default::default()
                                    },
                                )
                            } else {
                                current.clone()
                            };
                            let title_is_fallback = !raised.hook_seen;
                            let mut next = observe_title(
                                raised.clone(),
                                state.as_deref().unwrap_or(raised.state.as_str()),
                                now_ms(),
                            );
                            if title_is_fallback {
                                if probe.session_id.is_some() || probe.session_id_prefix.is_some() {
                                    next.session_id = probe.session_id.clone().or(next.session_id);
                                    next.session_id_prefix = probe.session_id_prefix.clone();
                                    next.identity_at = Some(now_ms());
                                }
                            }
                            debug::record(
                                &debug_log,
                                &id_cb,
                                debug::HarnessDebugEvent {
                                    at: now_ms(),
                                    source: "title".into(),
                                    event: if needs_input {
                                        "PermissionRequest".into()
                                    } else {
                                        state.clone().unwrap_or_else(|| "title".into())
                                    },
                                    state: next.state.clone(),
                                    session_id: next.session_id.clone(),
                                    prompt: None,
                                    note: Some(if needs_input {
                                        "osc9-or-action-required".into()
                                    } else {
                                        "codex-title".into()
                                    }),
                                },
                            );
                            let changed =
                                next.state != current.state || next.hook_seen != current.hook_seen;
                            note_state(
                                &id_cb,
                                "title",
                                if needs_input {
                                    "PermissionRequest"
                                } else {
                                    state.as_deref().unwrap_or("title")
                                },
                                &current.state,
                                &next.state,
                            );
                            map.insert(id_cb.clone(), next);
                            if changed {
                                live.notify("hook");
                            }
                        }
                    }
                }
            }
            if track_shell_commands {
                if let Some((running, exit_code)) = kinds::shell::probe_chunk(data) {
                    let mut map = probes.lock();
                    if let Some(current) = map.get_mut(&id_cb) {
                        current.shell_command_running = Some(running);
                        if running {
                            current.shell_command_started_at = Some(now_ms());
                        }
                        if !running {
                            current.shell_exit_code = exit_code;
                        }
                        live.notify("shell");
                    }
                }
            }
        });

        mark("pty-begin");
        terminals.create(
            workspace.runtime_cwd.clone(),
            100,
            30,
            Some(terminal_id.clone()),
            spawn,
            true,
            Some(on_output),
        )?;
        mark("pty-created");
        // Per-harness canvas pinning (e.g. Grok's own dark canvas) intentionally
        // lives outside this pipeline; the frontend owns per-harness theming.

        Ok(HarnessSession {
            kind: kind.to_string(),
            terminal_id,
            state: if shell_card {
                "attention".into()
            } else {
                "starting".into()
            },
            version,
            reply_preview: None,
            shell_command_notifications: Some(shell_notifications),
            shell_command_started_at: None,
            shell_command_running: None,
            shell_notify: None,
            shell_exit_code: None,
            exit_code: None,
            provider_session_id: resume.as_ref().and_then(|s| s.provider_session_id.clone()),
            session_name: resume
                .as_ref()
                .and_then(|s| s.session_name.clone())
                .or_else(|| {
                    if shell_card {
                        Some(workspace.name.clone())
                    } else {
                        None
                    }
                }),
            first_prompt: resume.as_ref().and_then(|s| s.first_prompt.clone()),
            submit_prompt: resume.as_ref().and_then(|s| s.submit_prompt.clone()),
            title: None,
            unpersisted_session: None,
            remote: Some(workspace.kind == "ssh"),
            source: None,
            probe: None,
            tmux: if workspace.kind == "ssh" {
                Some(use_tmux)
            } else {
                None
            },
        })
    }
}

async fn detect_version(
    workspace: &QueueWorkspace,
    command_path: &str,
    prefix: &[String],
    flag: &str,
    env: &HashMap<String, String>,
) -> AppResult<String> {
    if workspace.kind == "ssh" {
        let host = workspace
            .ssh_host
            .as_deref()
            .ok_or_else(|| AppError::machine("WORKSPACE_MISSING"))?;
        let cmd = format!(
            "{} {}",
            command_path
                .rsplit(['/', '\\'])
                .next()
                .unwrap_or(command_path),
            flag
        );
        let out = ssh_login_exec(host, &cmd).await?;
        return Ok(String::from_utf8_lossy(&out).trim().to_string());
    }
    let mut argv: Vec<String> = prefix.to_vec();
    argv.push(flag.to_string());
    let (program, args) = if cfg!(windows) {
        let launch = windows_command(command_path, &argv);
        (launch.executable, launch.args)
    } else {
        (command_path.to_string(), argv)
    };
    let mut command = tokio::process::Command::new(program);
    command.args(args);
    command.current_dir(&workspace.cwd);
    for (key, value) in env {
        command.env(key, value);
    }
    command.no_window();
    let output = command
        .output()
        .await
        .map_err(|e| AppError::msg(format!("启动检测失败：{e}")))?;
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn note_state(term: &str, source: &str, event: &str, from: &str, to: &str) {
    if from != to {
        crate::debuglog::info_term("harness", term, &format!("{from}->{to} {source}/{event}"));
    } else {
        crate::debuglog::debug_term("harness", term, &format!("{source}/{event} state={to}"));
    }
}

fn signal_file_re() -> &'static regex::Regex {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"^\d+-[a-f0-9-]+\.json$").unwrap())
}

fn apply_file_signals(
    probes: &Mutex<HashMap<String, ProbeState>>,
    debug_log: &debug::DebugLog,
    terminals: &TerminalHub,
    terminal_id: &str,
) -> bool {
    // API snapshots and the watcher both drain signals. A single non-blocking
    // drain preserves file order and prevents applying the same event twice.
    // Readers that lose the race use the probe snapshot the active drain updates.
    static DRAIN: Mutex<()> = Mutex::new(());
    let Some(_drain) = DRAIN.try_lock() else {
        return false;
    };
    let directory = signal_dir(terminal_id);
    let Ok(entries) = std::fs::read_dir(&directory) else {
        return false;
    };
    let mut files: Vec<_> = entries
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| signal_file_re().is_match(name))
        })
        .collect();
    files.sort();
    let mut changed = false;
    for path in files.into_iter().take(200) {
        if let Ok(raw) = std::fs::read_to_string(&path) {
            if let Some(signal) = signals::parse_file_signal(&raw) {
                let mut map = probes.lock();
                if let Some(current) = map.get(terminal_id).cloned() {
                    let mut next = observe_hook(current.clone(), signal.clone());
                    refresh_probe_label(&mut next);
                    // Second leg of the latency: spawn -> first hook. Stamped from
                    // the CLI's own `signal.at` (what the hook process wrote) when
                    // the delta is sane, and from the ingest clock otherwise — a
                    // stale clock would otherwise fabricate a huge number that
                    // looks like a real finding. Logged once per terminal; later
                    // hooks leave the field alone.
                    if next.first_hook_at_ms.is_none() {
                        next.first_hook_at_ms = Some(signal.at);
                        // Mirror the stamp onto the PTY probe so `card_report`
                        // carries both legs of the latency in one place, and
                        // replaying the log needs no cross-referencing.
                        terminals.record_first_hook(terminal_id, signal.at);
                        if let Some(spawned) = next.spawned_at_ms {
                            let wired = signal.at - spawned;
                            let wall = now_ms() - spawned;
                            let delta = if (0..=600_000).contains(&wired) {
                                wired
                            } else {
                                wall
                            };
                            crate::debuglog::info_term(
                                "harness",
                                terminal_id,
                                &format!(
                                    "first hook after {delta}ms ({} event={}{})",
                                    if (0..=600_000).contains(&wired) {
                                        "hook"
                                    } else {
                                        "ingest"
                                    },
                                    signal.event,
                                    if (0..=600_000).contains(&wired) {
                                        ""
                                    } else {
                                        " [hook clock implausible]"
                                    },
                                ),
                            );
                        }
                    }
                    debug::record(
                        debug_log,
                        terminal_id,
                        debug::HarnessDebugEvent {
                            at: signal.at,
                            source: "file".into(),
                            event: signal.event.clone(),
                            state: next.state.clone(),
                            session_id: signal.session_id.clone(),
                            prompt: signal.prompt.clone(),
                            note: None,
                        },
                    );
                    if next.state != current.state
                        || next.hook_seen != current.hook_seen
                        || next.session_name != current.session_name
                        || next.first_prompt != current.first_prompt
                        || next.submit_prompt != current.submit_prompt
                    {
                        changed = true;
                    }
                    note_state(
                        terminal_id,
                        "file",
                        &signal.event,
                        &current.state,
                        &next.state,
                    );
                    map.insert(terminal_id.to_string(), next);
                }
            }
        }
        let _ = std::fs::remove_file(path);
    }
    changed
}

fn start_signal_watch(
    probes: Arc<Mutex<HashMap<String, ProbeState>>>,
    debug_log: Arc<debug::DebugLog>,
    terminals: TerminalHub,
    live: LiveBus,
) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(250));
        let ids: Vec<String> = probes.lock().keys().cloned().collect();
        let mut changed = false;
        for id in ids {
            if apply_file_signals(&probes, &debug_log, &terminals, &id) {
                changed = true;
            }
            if promote_held(&probes, &debug_log, &id) {
                changed = true;
            }
        }
        if changed {
            live.notify("hook");
        }
    });
}

/// Raise the guessed asks whose window has run out.
///
/// Nothing else will: the point of a hold is that no further hook is coming. Ticking
/// here keeps it on the same clock as the file signals, so a card is only promoted
/// while its probe is still alive.
fn promote_held(
    probes: &Mutex<HashMap<String, ProbeState>>,
    debug_log: &debug::DebugLog,
    terminal_id: &str,
) -> bool {
    let now = now_ms();
    let mut map = probes.lock();
    let Some(current) = map.get(terminal_id).cloned() else {
        return false;
    };
    let Some(next) = settle_held(current.clone(), now) else {
        return false;
    };
    let held_for = current.held_attention_at.map(|at| now - at).unwrap_or(0);
    let tool = current.held_tool.clone().unwrap_or_else(|| "-".into());
    debug::record(
        debug_log,
        terminal_id,
        debug::HarnessDebugEvent {
            at: now,
            source: "hook".into(),
            event: "HeldAsk".into(),
            state: next.state.clone(),
            session_id: next.session_id.clone(),
            prompt: None,
            note: Some(format!("held {held_for}ms tool={tool}")),
        },
    );
    note_state(terminal_id, "hook", "HeldAsk", &current.state, &next.state);
    map.insert(terminal_id.to_string(), next);
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::HarnessSession;

    fn session(state: &str) -> HarnessSession {
        HarnessSession {
            kind: "codex".into(),
            terminal_id: "gone".into(),
            state: state.into(),
            version: String::new(),
            reply_preview: None,
            shell_command_notifications: None,
            shell_command_started_at: None,
            shell_command_running: None,
            shell_notify: None,
            shell_exit_code: None,
            exit_code: None,
            provider_session_id: Some("sess".into()),
            session_name: None,
            first_prompt: None,
            submit_prompt: None,
            title: None,
            unpersisted_session: None,
            remote: None,
            source: None,
            probe: None,
            tmux: None,
        }
    }

    #[test]
    fn snapshot_without_live_terminal_is_error() {
        let live = LiveBus::new();
        let terminals = TerminalHub::new(live.clone());
        let runtime = HarnessRuntime::new(live, terminals.clone());
        let next = runtime.snapshot(&session("attention"), &terminals);
        assert_eq!(next.state, "error");
        assert_eq!(next.probe.as_deref(), Some("unconfirmed"));
    }

    #[test]
    fn snapshot_drops_missing_codex_rollout() {
        let live = LiveBus::new();
        let terminals = TerminalHub::new(live.clone());
        let runtime = HarnessRuntime::new(live, terminals.clone());
        let mut current = session("exited");
        current.provider_session_id = Some("00000000-0000-0000-0000-000000000000".into());
        let next = runtime.snapshot(&current, &terminals);
        assert_eq!(next.provider_session_id, None);
        assert_eq!(next.unpersisted_session, Some(true));
    }
}
