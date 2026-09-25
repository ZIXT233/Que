mod debug;
mod env;
mod extensions;
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
pub use extensions::{
    errors as extension_errors, list as extension_harnesses, refresh as refresh_extensions,
};
pub use external::ExternalRuntime;
pub use hooks::{prepare_hook_launch, sync_external_hooks, sync_installed_hooks};
pub use osc::HookOscProbe;
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
pub(crate) use kinds::shell::prepare_shell;
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

    pub fn snapshot(
        &self,
        session: &HarnessSession,
        terminals: &TerminalHub,
        workspace: Option<&QueueWorkspace>,
    ) -> HarnessSession {
        let session_env = workspace
            .map(crate::workspace_rc::session_environment)
            .unwrap_or_default();
        let harness = find(&session.kind);
        // A harness without an adapter is a shell card: its state comes off the PTY.
        let shell_card = harness.is_some_and(|h| h.adapter().is_none());
        let mut current = self.probes.lock().get(&session.terminal_id).cloned();
        if current.is_some() {
            apply_file_signals(&self.probes, &self.debug, terminals, &session.terminal_id);
            current = self.probes.lock().get(&session.terminal_id).cloned();
        }
        if !session_env.is_empty() {
            if let Some(state) = current.as_mut() {
                if let (Some(kind), Some(id)) = (state.kind.as_deref(), state.session_id.as_deref())
                {
                    if !state.remote {
                        if let Some(label) =
                            session_label::read_session_label_in(kind, id, &session_env)
                        {
                            if label.name.is_some() {
                                state.session_name = label.name;
                            }
                            if state.first_prompt.is_none() {
                                state.first_prompt = label.first_prompt;
                            }
                        }
                    }
                }
            }
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
            provider_session_id = provider_session_id
                .filter(|id| id.to_lowercase().starts_with(&prefix))
                .or_else(|| {
                    if session.remote == Some(true) {
                        None
                    } else {
                        harness.and_then(|h| h.resolve_session_prefix(&prefix))
                    }
                });
        }
        let terminal = terminals.snapshot(&session.terminal_id);
        let dead = terminal.as_ref().is_none_or(|t| t.exited);
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
                provider_session_id = Some(footer_id);
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
            None => "not_running".into(),
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
        next.unpersisted_session = None;
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
        let is_extension = extensions::find(kind).is_some();
        if is_extension {
            if let Some(session_id) = resume
                .as_ref()
                .and_then(|s| s.provider_session_id.as_deref())
            {
                registry::checked_id(session_id)?;
            }
        }
        let mut extension_command = None;
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
        if !shell_card
            && !is_extension
            && workspace.kind == "ssh"
            && crate::workspace_rc::script(workspace).is_none()
        {
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
            let executable = adapter.executable;
            let mut command_path = executable.to_string();
            let mut command_prefix: Vec<String> = Vec::new();
            let tweaks: LaunchTweaks = harness.launch_tweaks();
            if workspace.kind == "local" && crate::workspace_rc::script(workspace).is_none() {
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
                    env::resolve_local_command(executable, &local, &extra_dirs)
                {
                    command_path = resolved;
                    env = local;
                } else {
                    local = local_environment(true).await.unwrap_or_default();
                    if let Some(resolved) =
                        env::resolve_local_command(executable, &local, &extra_dirs)
                    {
                        command_path = resolved;
                        env = local;
                    } else {
                        return Err(AppError::machine_detail(
                            "HARNESS_CLI_MISSING",
                            executable,
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
            env.extend(crate::workspace_rc::session_environment(workspace));
            // Most probes are display-only; OpenCode selects its plugin API here.
            mark("environment-and-command-ready");
            // keep it off the connect path — a shim probe through cmd/PowerShell
            // costs seconds — and publish the answer via the snapshot overlay.
            if is_extension {
                // The extension owns its version policy; do not probe the Node runner.
            } else if kind == "opencode" {
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
            let mut hooks = match prepare_hook_launch(
                kind,
                &signals,
                workspace,
                &terminal_id,
                bin_dir,
                &version,
            )
            .await
            {
                Ok(hooks) => hooks,
                Err(error) => {
                    crate::debuglog::log_error(
                        &format!("harness hook install kind={kind}"),
                        &error,
                    );
                    return Err(error);
                }
            };
            if is_extension {
                // Upload the module before calling its install callback. The remote
                // launch script is uploaded later, once launch/resume is resolved.
                hooks.install(None).await?;
                hooks.install_extension().await?;
                let mode = if resume.is_some() { "resume" } else { "launch" };
                let spec = extensions::command(
                    kind,
                    mode,
                    workspace,
                    resume.as_ref().and_then(|s| s.provider_session_id.as_deref()),
                    &hooks.extension_dir(),
                    bin_dir,
                )
                .await?;
                command_path = if workspace.kind == "local"
                    && crate::workspace_rc::script(workspace).is_none()
                {
                    env::resolve_local_command(&spec.command, &env, &[])
                        .ok_or_else(|| AppError::machine_detail("HARNESS_CLI_MISSING", &spec.command))?
                } else {
                    spec.command.clone()
                };
                extension_command = Some(spec);
            }
            env.extend(std::mem::take(&mut hooks.env));
            mark("hooks-planned");
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
            if !is_extension {
                if let Some(session_id) = resume
                    .as_ref()
                    .and_then(|s| s.provider_session_id.as_deref())
                {
                    launch_args.extend(adapter.resume_args(session_id)?);
                }
            }
            if let Some(spec) = &extension_command {
                launch_args.extend(spec.args.iter().cloned());
            } else {
                launch_args.extend(adapter.args.iter().map(|s| s.to_string()));
            }
            launch_args.extend(std::mem::take(&mut hooks.args));
            let launch_executable = extension_command.as_ref().map(|spec| spec.command.as_str()).unwrap_or(adapter.executable);
            let mut launch_script = None;
            if workspace.kind == "ssh" {
                let host = workspace
                    .ssh_host
                    .as_deref()
                    .ok_or_else(|| AppError::machine("WORKSPACE_MISSING"))?;
                let exports = env
                    .iter()
                    .map(|(k, v)| {
                        format!(
                            "{k}={}",
                            if workspace.session_env.contains_key(k) {
                                crate::workspace_rc::remote_session_value(v)
                            } else {
                                crate::ssh::shell_quote(v)
                            }
                        )
                    })
                    .collect::<Vec<_>>()
                    .join(" ");
                let command = std::iter::once(launch_executable.to_string())
                    .chain(launch_args)
                    .map(|s| crate::ssh::shell_quote(&s))
                    .collect::<Vec<_>>()
                    .join(" ");
                let rc_body = if crate::workspace_rc::script(workspace).is_some() {
                    let quoted = crate::ssh::shell_quote(launch_executable);
                    let alias_command =
                        format!("{}{}", launch_executable, &command[quoted.len()..]);
                    Some(crate::workspace_rc::body(workspace, &alias_command))
                } else {
                    None
                };
                // Put the launch script on the remote host before opening the PTY.
                // The SSH exec command and tmux pane now receive only a file path,
                // so RC text, environment values, and hook overrides never expand
                // through several nested shell -c arguments.
                let script_path = hooks.remote_launch_path(&terminal_id)?;
                let script = remote_launch_script(
                    &script_path,
                    &terminal_id,
                    &exports,
                    &command,
                    rc_body.as_deref(),
                );
                let launch_command = format!(
                    "exec /bin/sh {}",
                    crate::ssh::shell_quote(&script_path.to_string_lossy())
                );
                launch_script = Some((script_path, script));
                let unset = tweaks
                    .ssh_unset
                    .iter()
                    .map(|name| format!("unset {name} && "))
                    .collect::<String>();
                let remote = if use_tmux {
                    let term_id = crate::ssh::card_tmux_session_id(card_id);
                    let wrapped = crate::ssh::wrap_remote_tmux_with_channel(
                        &term_id,
                        &workspace.cwd,
                        &launch_command,
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
                        "cd {} && {}{}",
                        crate::ssh::shell_quote(&workspace.cwd),
                        unset,
                        launch_command
                    )
                };
                spawn = Spawn::Remote {
                    host: host.to_string(),
                    command: ssh_login_command(&remote),
                };
            } else if crate::workspace_rc::script(workspace).is_some() {
                let (executable, args) = crate::workspace_rc::local_command(
                    workspace,
                    launch_executable,
                    &launch_args,
                )?;
                spawn = Spawn::Local {
                    executable,
                    args,
                    env,
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
            if is_extension {
                hooks.install_launch_script(launch_script.as_ref().map(|(path, body)| (path.as_path(), body.as_str()))).await?;
            } else {
                hooks.install(
                    launch_script
                        .as_ref()
                        .map(|(path, body)| (path.as_path(), body.as_str())),
                )
                .await?;
            }
            crate::debuglog::info_term(
                "harness",
                &terminal_id,
                &format!("hooks installed kind={kind}"),
            );
            mark("hooks-ready");
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

fn remote_launch_script(
    path: &std::path::Path,
    terminal_id: &str,
    exports: &str,
    command: &str,
    rc_body: Option<&str>,
) -> String {
    let quoted_path = crate::ssh::shell_quote(&path.to_string_lossy());
    let mut script = String::new();
    if rc_body.is_some() {
        // The login shell must see the card environment while it reads its rc
        // files. Source the same script after startup; the marker prevents a loop.
        script.push_str(&format!(
            "if [ \"${{QUE_HARNESS_LAUNCH_STAGE:-}}\" != {} ]; then\n",
            crate::ssh::shell_quote(terminal_id)
        ));
    }
    if !exports.is_empty() {
        script.push_str(&format!("export {exports} || exit $?\n"));
    }
    script.push_str("QUE_HARNESS_TTY=$(tty) || exit $?\nexport QUE_HARNESS_TTY || exit $?\n");
    if rc_body.is_some() {
        script.push_str(&format!(
            "QUE_HARNESS_LAUNCH_STAGE={}\nexport QUE_HARNESS_LAUNCH_STAGE\nexec \"${{SHELL:-/bin/bash}}\" -ilc {}\nfi\nunset QUE_HARNESS_LAUNCH_STAGE\n",
            crate::ssh::shell_quote(terminal_id),
            crate::ssh::shell_quote(&format!(". {quoted_path}"))
        ));
    }
    script.push_str(&format!("rm -f -- {quoted_path} || :\n"));
    if let Some(body) = rc_body {
        script.push_str(body);
    } else {
        script.push_str(&format!("exec {command}\n"));
    }
    script
}

async fn detect_version(
    workspace: &QueueWorkspace,
    command_path: &str,
    prefix: &[String],
    flag: &str,
    env: &HashMap<String, String>,
) -> AppResult<String> {
    if crate::workspace_rc::script(workspace).is_some() {
        let cmd = format!("{} {}", command_path, crate::ssh::shell_quote(flag));
        if workspace.kind == "ssh" {
            let out = crate::workspace_rc::remote_exec(workspace, &cmd, "").await?;
            return Ok(String::from_utf8_lossy(&out).trim().into());
        }
        let (program, args) =
            crate::workspace_rc::local_command(workspace, command_path, &[flag.into()])?;
        let output = tokio::process::Command::new(program)
            .args(args)
            .envs(env)
            .kill_on_drop(true)
            .output()
            .await?;
        return Ok(String::from_utf8_lossy(&output.stdout).trim().into());
    }
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

    #[test]
    #[cfg(unix)]
    fn remote_launch_sources_rc_after_exporting_card_environment() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let tty = dir.path().join("tty");
        std::fs::write(&tty, "#!/bin/sh\nprintf /dev/pts/test\n").unwrap();
        std::fs::set_permissions(&tty, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::write(
            dir.path().join(".bash_profile"),
            "printf '%s|%s' \"$TEST_EXPORT\" \"$QUE_HARNESS_TTY\" > \"$HOME/login-marker\"\n",
        )
        .unwrap();
        let path = dir.path().join("launch.sh");
        let script = remote_launch_script(
            &path,
            "test-terminal",
            "TEST_EXPORT='card-value'",
            "ignored",
            Some("printf '%s|%s|%s' \"$TEST_EXPORT\" \"$QUE_HARNESS_TTY\" \"${QUE_HARNESS_LAUNCH_STAGE-unset}\""),
        );
        std::fs::write(&path, script).unwrap();
        let output = std::process::Command::new("/bin/sh")
            .arg(&path)
            .env("SHELL", "/bin/bash")
            .env("HOME", dir.path())
            .env(
                "PATH",
                format!(
                    "{}:{}",
                    dir.path().display(),
                    std::env::var("PATH").unwrap_or_default()
                ),
            )
            .env_remove("QUE_HARNESS_LAUNCH_STAGE")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(output.stdout, b"card-value|/dev/pts/test|unset");
        assert_eq!(
            std::fs::read(dir.path().join("login-marker")).unwrap(),
            b"card-value|/dev/pts/test"
        );
        assert!(!path.exists());
    }

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
    fn snapshot_without_live_terminal_is_not_running() {
        let live = LiveBus::new();
        let terminals = TerminalHub::new(live.clone());
        let runtime = HarnessRuntime::new(live, terminals.clone());
        let next = runtime.snapshot(&session("attention"), &terminals, None);
        assert_eq!(next.state, "not_running");
        assert_eq!(next.probe.as_deref(), Some("unconfirmed"));
    }

    #[test]
    fn snapshot_keeps_known_codex_id_even_when_rollout_is_not_in_default_store() {
        let live = LiveBus::new();
        let terminals = TerminalHub::new(live.clone());
        let runtime = HarnessRuntime::new(live, terminals.clone());
        let mut current = session("exited");
        current.provider_session_id = Some("00000000-0000-0000-0000-000000000000".into());
        let next = runtime.snapshot(&current, &terminals, None);
        assert_eq!(next.provider_session_id, current.provider_session_id);
        assert_eq!(next.unpersisted_session, None);
    }

    #[test]
    fn snapshot_keeps_known_claude_id_even_when_session_is_not_in_default_store() {
        let live = LiveBus::new();
        let terminals = TerminalHub::new(live.clone());
        let runtime = HarnessRuntime::new(live, terminals.clone());
        let mut current = session("exited");
        current.kind = "claude".into();
        current.provider_session_id = Some("00000000-0000-0000-0000-000000000000".into());
        let next = runtime.snapshot(&current, &terminals, None);
        assert_eq!(next.provider_session_id, current.provider_session_id);
        assert_eq!(next.unpersisted_session, None);
    }

    #[test]
    fn snapshot_keeps_claude_session_in_workspace_configured_store() {
        let root = tempfile::tempdir().unwrap();
        let id = "118fcbc2-ca87-4f0c-ba01-f3f2de9359cd";
        let project = root.path().join("projects/project");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(project.join(format!("{id}.jsonl")), "").unwrap();
        let workspace: QueueWorkspace = serde_json::from_value(serde_json::json!({
            "id":"configured-store", "name":"Workspace", "kind":"local",
            "cwd":root.path(), "runtimeCwd":root.path()
        }))
        .unwrap();
        let mut queue = crate::models::CardQueue::empty();
        queue.machine_settings.insert(
            "local".into(),
            crate::models::MachineSessionSettings {
                terminal_rc: None,
                session_env: HashMap::from([(
                    "CLAUDE_CONFIG_DIR".into(),
                    root.path().to_string_lossy().into_owned(),
                )]),
            },
        );
        let workspace = crate::workspace_rc::effective_workspace(&queue, &workspace);
        let live = LiveBus::new();
        let terminals = TerminalHub::new(live.clone());
        let runtime = HarnessRuntime::new(live, terminals.clone());
        let mut current = session("exited");
        current.kind = "claude".into();
        current.provider_session_id = Some(id.into());
        let next = runtime.snapshot(&current, &terminals, Some(&workspace));
        assert_eq!(next.provider_session_id.as_deref(), Some(id));
        assert_eq!(next.unpersisted_session, None);
    }

    #[test]
    fn snapshot_keeps_codex_session_in_workspace_configured_store() {
        let root = tempfile::tempdir().unwrap();
        let id = "118fcbc2-ca87-4f0c-ba01-f3f2de9359cd";
        let sessions = root.path().join("sessions/2026/09/23");
        std::fs::create_dir_all(&sessions).unwrap();
        std::fs::write(
            sessions.join(format!("rollout-2026-09-23T00-00-00-{id}.jsonl")),
            "",
        )
        .unwrap();
        let workspace: QueueWorkspace = serde_json::from_value(serde_json::json!({
            "id":"configured-store", "name":"Workspace", "kind":"local",
            "cwd":root.path(), "runtimeCwd":root.path()
        }))
        .unwrap();
        let mut queue = crate::models::CardQueue::empty();
        queue.machine_settings.insert(
            "local".into(),
            crate::models::MachineSessionSettings {
                terminal_rc: None,
                session_env: HashMap::from([(
                    "CODEX_HOME".into(),
                    root.path().to_string_lossy().into_owned(),
                )]),
            },
        );
        let workspace = crate::workspace_rc::effective_workspace(&queue, &workspace);
        let live = LiveBus::new();
        let terminals = TerminalHub::new(live.clone());
        let runtime = HarnessRuntime::new(live, terminals.clone());
        let mut current = session("exited");
        current.kind = "codex".into();
        current.provider_session_id = Some(id.into());
        let next = runtime.snapshot(&current, &terminals, Some(&workspace));
        assert_eq!(next.provider_session_id.as_deref(), Some(id));
        assert_eq!(next.unpersisted_session, None);
    }
}
