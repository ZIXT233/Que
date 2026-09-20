use crate::error::{AppError, AppResult};
use crate::live::LiveBus;
use crate::models::HarnessSession;
use crate::remote::PtyCommand;
use crate::transcript::{read_terminal_transcript, save_terminal_transcript, TerminalTranscript};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

/// Default backlog kept per session in memory and stored to transcript.
/// Can be customized via QUE_TERMINAL_BACKLOG_BYTES (set to 0 for unlimited).
const DEFAULT_MAX_BACKLOG: usize = 20 * 1024 * 1024; // 20 MB

fn max_backlog() -> usize {
    if let Ok(val) = std::env::var("QUE_TERMINAL_BACKLOG_BYTES") {
        if let Ok(bytes) = val.parse::<usize>() {
            return bytes;
        }
    }
    DEFAULT_MAX_BACKLOG
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum TerminalEvent {
    /// `from` is the byte offset where `data` starts, `offset` where it ends.
    /// Clients use `from` to detect gaps in the stream and resync instead of
    /// rendering a hole as terminal garbage.
    ///
    /// `dropped` is set only on a reset that had to sacrifice bytes: the client's
    /// cursor pointed before the oldest byte we still hold, so the replay cannot
    /// be a superset of what it already saw. Without this the client cannot tell
    /// "first attach, nothing lost" from "trimmed, the head is gone", and a real
    /// hole gets presented as a clean redraw.
    Output {
        data: String,
        from: u64,
        offset: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        reset: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none")]
        dropped: Option<u64>,
    },
    Exit {
        #[serde(rename = "exitCode")]
        exit_code: i32,
    },
    Closed,
}

/// Where a session's bytes come from.
///
/// Local sessions still need a pty: `cmd.exe`, PowerShell and `$SHELL` all check
/// `isatty()` before they will behave like an interactive shell. Remote sessions
/// do not. Their pty is created by the SSH server on the far side, so a second,
/// local pty adds nothing — and on Windows ConPTY is not even a transparent
/// pipe: it renders into a screen buffer and re-serializes the escape sequences
/// before they reach the front end.
pub enum Spawn {
    Local {
        executable: String,
        args: Vec<String>,
        env: HashMap<String, String>,
    },
    Remote {
        host: String,
        command: String,
    },
}

pub struct TerminalSnapshot {
    pub cwd: String,
    pub exited: bool,
    pub exit_code: Option<i32>,
    pub output: String,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyProbe {
    pub reader_alive: bool,
    pub chunks: u64,
    pub bytes_in: u64,
    pub decode_held: u64,
    pub events_emitted: u64,
    pub listeners: usize,
    pub send_fail: u64,
    pub backlog_bytes: usize,
    pub offset: u64,
    pub writes: u64,
    pub write_ok: u64,
    pub write_err: u64,
    pub last_write_ms: u64,
    pub last_write_bytes: usize,
    pub resize_count: u64,
    pub last_resize_cols: u16,
    pub last_resize_rows: u16,
    pub last_resize_ok: bool,
    pub ioctl_cols: Option<u16>,
    pub ioctl_rows: Option<u16>,
    pub on_output_panic: u64,
    /// Milliseconds from spawn to the CLI's first output byte. This is the one
    /// number that splits a slow card in two: everything before it is the CLI
    /// booting, everything after belongs to its first hook landing. Without it
    /// the whole window is a black box and "the card took 22s" has no owner.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_byte_ms: Option<u64>,
    /// Milliseconds from spawn to the first hook signal for this terminal. Only
    /// meaningful once a hook has arrived; `None` means none ever did. Stamped
    /// by the harness when the signal lands, since the PTY layer never sees a
    /// hook — it only carries the bytes.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_hook_ms: Option<u64>,
    /// Spawn instant, kept so a late reader can derive its own deltas.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spawned_at_ms: Option<u64>,
    /// "local" or "ssh" — makes it obvious which pipeline a session used.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transport: Option<String>,
    /// Reconnects where the client's cursor had fallen behind the oldest byte we
    /// still held, summed in bytes. This is the only counter here that represents
    /// data the user actually lost; `send_fail` counts ordinary pauses and
    /// `backlog_bytes` is just current occupancy.
    pub replay_dropped_bytes: u64,
    /// How many resets we served because of such a loss (vs. a clean first
    /// attach). A rising count with a large `replay_dropped_bytes` means
    /// MAX_BACKLOG is too small for this session's output rate.
    pub replay_trimmed: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_focus: Option<String>,
}

/// The write/resize/kill side of a session, whichever transport is behind it.
///
/// Deliberately synchronous: `TerminalHub`'s write/resize/kill are called from
/// synchronous code paths, so the remote implementation forwards onto a queue
/// that the SSH task drains rather than making every caller async.
trait Channel: Send + Sync {
    fn write(&self, data: &[u8]) -> bool;
    fn resize(&self, cols: u16, rows: u16) -> bool;
    fn size(&self) -> Option<(u16, u16)>;
    fn kill(&self);
}

struct LocalChannel {
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    killer: Mutex<Option<Box<dyn ChildKiller + Send + Sync>>>,
}

impl Channel for LocalChannel {
    fn write(&self, data: &[u8]) -> bool {
        lock(&self.writer)
            .as_mut()
            .is_some_and(|writer| writer.write_all(data).is_ok())
    }

    fn resize(&self, cols: u16, rows: u16) -> bool {
        lock(&self.master).as_mut().is_some_and(|master| {
            master
                .resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .is_ok()
        })
    }

    fn size(&self) -> Option<(u16, u16)> {
        lock(&self.master)
            .as_ref()
            .and_then(|master| master.get_size().ok())
            .map(|size| (size.cols, size.rows))
    }

    fn kill(&self) {
        if let Some(killer) = lock(&self.killer).as_mut() {
            let _ = killer.kill();
        }
    }
}

struct RemoteChannel {
    commands: mpsc::UnboundedSender<PtyCommand>,
    size: Mutex<(u16, u16)>,
    closed: AtomicBool,
}

impl Channel for RemoteChannel {
    fn write(&self, data: &[u8]) -> bool {
        if self.closed.load(Ordering::Relaxed) {
            return false;
        }
        self.commands.send(PtyCommand::Data(data.to_vec())).is_ok()
    }

    fn resize(&self, cols: u16, rows: u16) -> bool {
        if self.commands.send(PtyCommand::Resize(cols, rows)).is_err() {
            return false;
        }
        *lock(&self.size) = (cols, rows);
        true
    }

    fn size(&self) -> Option<(u16, u16)> {
        Some(*lock(&self.size))
    }

    fn kill(&self) {
        self.closed.store(true, Ordering::Relaxed);
        let _ = self.commands.send(PtyCommand::Close);
    }
}

struct Record {
    cwd: String,
    backlog: String,
    offset: u64,
    /// Bytes of an incomplete UTF-8 sequence held over from the previous chunk.
    pending: Vec<u8>,
    exited: bool,
    exit_code: Option<i32>,
    persistent: bool,
    channel: Arc<dyn Channel>,
    last_listener: Instant,
    listeners: usize,
    on_output: Option<Arc<dyn Fn(&str) + Send + Sync>>,
    listeners_tx: Vec<mpsc::UnboundedSender<TerminalEvent>>,
    dirty: bool,
    probe: Arc<Mutex<PtyProbe>>,
    canvas_dark: bool,
    canvas_campbell: bool,
    theme_notify: bool,
    theme_notify_parser: crate::terminal_theme::ThemeNotifyParser,
    /// Cumulative bytes lost to backlog trimming on reconnect (see `subscribe`).
    replay_dropped_bytes: u64,
    /// How many times that happened, so a single large loss is distinguishable
    /// from a steady drip.
    replay_trimmed: u64,
}

#[derive(Clone)]
pub struct TerminalHub {
    inner: Arc<Mutex<HashMap<String, Record>>>,
    live: LiveBus,
}

impl TerminalHub {
    pub fn new(live: LiveBus) -> Self {
        let inner = Arc::new(Mutex::new(HashMap::new()));
        let hub = Self {
            inner: inner.clone(),
            live,
        };
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_secs(1));
            persist_dirty(&inner);
        });
        hub
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<String, Record>> {
        lock(&self.inner)
    }

    pub fn create(
        &self,
        cwd: String,
        cols: u16,
        rows: u16,
        id: Option<String>,
        spawn: Spawn,
        persistent: bool,
        on_output: Option<Arc<dyn Fn(&str) + Send + Sync>>,
    ) -> AppResult<String> {
        let cwd = if cwd.is_empty() {
            dirs::home_dir()
                .unwrap_or_else(|| std::path::PathBuf::from("."))
                .to_string_lossy()
                .into_owned()
        } else {
            cwd
        };
        let id = id.unwrap_or_else(|| uuid::Uuid::new_v4().simple().to_string());
        {
            let map = self.lock();
            if let Some(existing) = map.get(&id) {
                if existing.cwd != cwd {
                    return Err(AppError::msg("Terminal belongs to a different workspace"));
                }
                return Ok(id);
            }
        }
        let cols = dimension(cols, 80);
        let rows = dimension(rows, 24);
        let transport = match &spawn {
            Spawn::Local { .. } => "local",
            Spawn::Remote { .. } => "ssh",
        };
        crate::debuglog::info_term(
            "pty",
            &id,
            &format!(
                "spawn {transport} cwd={cwd:?} {cols}x{rows}{}",
                match &spawn {
                    Spawn::Local { executable, .. } => format!(" exe={executable}"),
                    Spawn::Remote { host, .. } => format!(" host={host}"),
                }
            ),
        );
        // Stamped here rather than at register(): the gap this probe exists to
        // measure starts when we hand the command to the OS, not when the
        // bookkeeping record appears.
        let spawned_at_ms = crate::queue::now_ms().max(0) as u64;
        let probe = Arc::new(Mutex::new(PtyProbe {
            reader_alive: true,
            transport: Some(transport.into()),
            spawned_at_ms: Some(spawned_at_ms),
            ..PtyProbe::default()
        }));
        // Second chance if the startup preload missed the bundled conpty.dll;
        // decides whether Windows-local answers may follow the app theme.
        #[cfg(windows)]
        let _ = crate::conpty::ensure_loaded();
        // Campbell is only a fallback for the inbox ConPTY (whose default
        // canvas is #0C0C0C). With the bundled modern ConPTY the answered
        // colors follow the app theme like every other transport.
        let campbell =
            cfg!(windows) && matches!(spawn, Spawn::Local { .. }) && !crate::conpty::sideloaded();
        let canvas_dark = if campbell {
            true
        } else {
            spawn_canvas_dark(&spawn)
        };
        match spawn {
            Spawn::Local {
                executable,
                args,
                env,
            } => self.spawn_local(
                cwd,
                cols,
                rows,
                id.clone(),
                executable,
                args,
                env,
                persistent,
                on_output,
                probe,
                canvas_dark,
                campbell,
            )?,
            Spawn::Remote { host, command } => self.spawn_remote(
                cwd,
                cols,
                rows,
                id.clone(),
                host,
                command,
                persistent,
                on_output,
                probe,
                canvas_dark,
            ),
        }
        Ok(id)
    }

    #[allow(clippy::too_many_arguments)]
    fn spawn_local(
        &self,
        cwd: String,
        cols: u16,
        rows: u16,
        id: String,
        executable: String,
        args: Vec<String>,
        env: HashMap<String, String>,
        persistent: bool,
        on_output: Option<Arc<dyn Fn(&str) + Send + Sync>>,
        probe: Arc<Mutex<PtyProbe>>,
        canvas_dark: bool,
        campbell: bool,
    ) -> AppResult<()> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| AppError::msg(e.to_string()))?;
        let mut cmd = CommandBuilder::new(&executable);
        cmd.args(&args);
        cmd.cwd(&cwd);
        for (key, value) in env {
            cmd.env(key, value);
        }
        // Size must come from the PTY ioctl. COLUMNS/LINES inherited from the
        // Tauri/dev terminal (or a login-shell dump) make Ink/OpenCode/Cursor
        // draw the input row against the parent size, not this session.
        cmd.env_remove("COLUMNS");
        cmd.env_remove("LINES");
        cmd.env_remove("NO_COLOR");
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        if campbell {
            // Fallback (inbox ConPTY): its default table is Campbell (#0C0C0C).
            // A Solarized COLORFGBG would tell the CLI the canvas is cream
            // while the emulator stays black.
            cmd.env("COLORFGBG", crate::terminal_theme::colorfgbg(true));
        } else if cmd.get_env("COLORFGBG").is_none() {
            cmd.env("COLORFGBG", crate::terminal_theme::colorfgbg(canvas_dark));
        }
        if cmd.get_env("LANG").is_none()
            && cmd.get_env("LC_ALL").is_none()
            && cmd.get_env("LC_CTYPE").is_none()
        {
            cmd.env("LANG", "C.UTF-8");
        }
        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| AppError::msg(e.to_string()))?;
        let killer = child.clone_killer();
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| AppError::msg(e.to_string()))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| AppError::msg(e.to_string()))?;
        let channel: Arc<dyn Channel> = Arc::new(LocalChannel {
            writer: Mutex::new(Some(writer)),
            master: Mutex::new(Some(pair.master)),
            killer: Mutex::new(Some(killer)),
        });
        #[cfg(windows)]
        let handshake_channel = channel.clone();
        self.register(
            id.clone(),
            cwd,
            persistent,
            on_output,
            channel,
            probe.clone(),
            canvas_dark,
            campbell,
        );

        let inner = self.inner.clone();
        let live = self.live.clone();
        std::thread::spawn(move || {
            let mut buffer = [0u8; 8192];
            #[cfg(windows)]
            let mut handshake = crate::conpty::sideloaded()
                .then(crate::conpty_handshake::StartupHandshake::default);
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(n) => {
                        #[cfg(windows)]
                        if let Some(reply) = handshake.as_mut().and_then(|h| h.feed(&buffer[..n])) {
                            let ok = handshake_channel.write(reply);
                            crate::debuglog::info_term(
                                "pty",
                                &id,
                                &format!("ConPTY startup DA1 answered ok={ok}"),
                            );
                        }
                        deliver(&inner, &id, &probe, &buffer[..n]);
                    }
                    Err(error) => {
                        crate::debuglog::warn_term("pty", &id, &format!("reader error: {error}"));
                        lock(&probe).last_error = Some(error.to_string());
                        break;
                    }
                }
            }
            let mut child = child;
            let code = child.wait().ok().map(|s| s.exit_code() as i32).unwrap_or(0);
            finalize(&inner, &id, code, &live, &probe);
        });
        Ok(())
    }

    /// A remote session: one SSH channel carrying the pty, driven by a task that
    /// also drains the write/resize queue.
    #[allow(clippy::too_many_arguments)]
    fn spawn_remote(
        &self,
        cwd: String,
        cols: u16,
        rows: u16,
        id: String,
        host: String,
        command: String,
        persistent: bool,
        on_output: Option<Arc<dyn Fn(&str) + Send + Sync>>,
        probe: Arc<Mutex<PtyProbe>>,
        canvas_dark: bool,
    ) {
        let (commands, queue) = mpsc::unbounded_channel();
        let channel: Arc<dyn Channel> = Arc::new(RemoteChannel {
            commands,
            size: Mutex::new((cols, rows)),
            closed: AtomicBool::new(false),
        });
        self.register(
            id.clone(),
            cwd,
            persistent,
            on_output,
            channel,
            probe.clone(),
            canvas_dark,
            false,
        );

        let inner = self.inner.clone();
        let live = self.live.clone();
        let sink_inner = inner.clone();
        let sink_id = id.clone();
        let sink_probe = probe.clone();
        tokio::spawn(async move {
            crate::debuglog::debug_term(
                "pty",
                &id,
                &format!("remote run host={host:?} {cols}x{rows}"),
            );
            let result = crate::remote::run_pty(
                &host,
                &command,
                cols,
                rows,
                move |data: Vec<u8>| {
                    deliver(&sink_inner, &sink_id, &sink_probe, &data);
                },
                queue,
            )
            .await;
            let code = match result {
                Ok(code) => code,
                Err(error) => {
                    crate::debuglog::log_error(&format!("terminal remote spawn id={id}"), &error);
                    // Report the failure in the pane, where `ssh`'s own stderr
                    // used to land, instead of silently ending the session.
                    let text = format!("\r\n\x1b[31m{error}\x1b[0m\r\n");
                    deliver(&inner, &id, &probe, text.as_bytes());
                    1
                }
            };
            finalize(&inner, &id, code, &live, &probe);
        });
    }

    #[allow(clippy::too_many_arguments)]
    fn register(
        &self,
        id: String,
        cwd: String,
        persistent: bool,
        on_output: Option<Arc<dyn Fn(&str) + Send + Sync>>,
        channel: Arc<dyn Channel>,
        probe: Arc<Mutex<PtyProbe>>,
        canvas_dark: bool,
        canvas_campbell: bool,
    ) {
        let mut map = self.lock();
        map.insert(
            id,
            Record {
                cwd,
                backlog: String::new(),
                offset: 0,
                pending: Vec::new(),
                exited: false,
                exit_code: None,
                persistent,
                channel,
                last_listener: Instant::now(),
                listeners: 0,
                on_output,
                listeners_tx: Vec::new(),
                dirty: false,
                probe,
                canvas_dark,
                canvas_campbell,
                theme_notify: false,
                theme_notify_parser: crate::terminal_theme::ThemeNotifyParser::default(),
                replay_dropped_bytes: 0,
                replay_trimmed: 0,
            },
        );
    }

    /// Push a theme change to every live session that follows the app theme.
    /// Campbell-fallback records stay pinned to dark: their palette matches
    /// the inbox ConPTY's default canvas, which never follows our theme.
    #[cfg(test)]
    pub fn apply_canvas_dark(&self, dark: bool) {
        self.apply_canvas_theme(dark, false);
    }

    pub fn apply_canvas_theme(&self, dark: bool, refresh: bool) {
        crate::terminal_theme::set_app_dark(dark);
        let pending: Vec<(Arc<dyn Channel>, String)> = {
            let mut map = self.lock();
            map.values_mut()
                // Only CLIs that asked for theme reports (DECSET 2031) can
                // consume CSI ?997;1n; for everyone else it is unexpected
                // input that ConPTY echoes straight onto their prompt.
                .filter(|record| {
                    !record.exited
                        && !record.canvas_campbell
                        && record.theme_notify
                        && (refresh || record.canvas_dark != dark)
                })
                .map(|record| {
                    record.canvas_dark = dark;
                    (
                        record.channel.clone(),
                        crate::terminal_theme::theme_change_report(dark).to_string(),
                    )
                })
                .collect()
        };
        for (channel, report) in pending {
            channel.write(report.as_bytes());
        }
    }

    /// A side terminal on the local machine: the user's own shell.
    pub fn create_shell(
        &self,
        cwd: String,
        cols: u16,
        rows: u16,
        id: Option<String>,
    ) -> AppResult<String> {
        let (executable, args) = if cfg!(windows) {
            (
                std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".into()),
                Vec::new(),
            )
        } else {
            (
                std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into()),
                vec!["-l".into()],
            )
        };
        self.create(
            cwd,
            cols,
            rows,
            id,
            Spawn::Local {
                executable,
                args,
                env: HashMap::new(),
            },
            false,
            None,
        )
    }

    /// A side terminal on an SSH host: the remote user's login shell, started in
    /// the workspace's remote directory.
    ///
    /// `cwd` is a path on `host`, not here — it is what the shell `cd`s into, and
    /// the record's `cwd` only has to stay stable across re-attaches of the same
    /// terminal id.
    pub fn create_remote_shell(
        &self,
        cwd: String,
        cols: u16,
        rows: u16,
        id: Option<String>,
        host: String,
        use_tmux: bool,
        card_id: Option<String>,
    ) -> AppResult<String> {
        let term_id = id.unwrap_or_else(|| uuid::Uuid::new_v4().simple().to_string());
        let inner = crate::ssh::remote_login_shell(&cwd, crate::terminal_theme::app_dark());
        let command = if use_tmux {
            let session_id = if let Some(cid) = card_id.filter(|s| !s.is_empty()) {
                crate::ssh::card_side_tmux_session_id(&cid, &term_id)
            } else {
                term_id.clone()
            };
            let wrapped = crate::ssh::wrap_remote_tmux(&session_id, &cwd, &inner);
            crate::ssh::ssh_login_command(&wrapped)
        } else {
            inner
        };
        self.create(
            cwd,
            cols,
            rows,
            Some(term_id),
            Spawn::Remote { host, command },
            false,
            None,
        )
    }

    pub fn snapshot(&self, id: &str) -> Option<TerminalSnapshot> {
        self.lock().get(id).map(|r| TerminalSnapshot {
            cwd: r.cwd.clone(),
            exited: r.exited,
            exit_code: r.exit_code,
            output: r.backlog.clone(),
        })
    }

    pub fn cwd(&self, id: &str) -> Option<String> {
        self.lock()
            .get(id)
            .map(|r| r.cwd.clone())
            .or_else(|| read_terminal_transcript(id).map(|saved| saved.cwd))
    }

    pub fn write(&self, id: &str, data: &str) -> bool {
        self.write_bytes(id, data.as_bytes())
    }

    pub fn write_bytes(&self, id: &str, data: &[u8]) -> bool {
        let (channel, probe) = {
            let map = self.lock();
            let Some(record) = map.get(id) else {
                return false;
            };
            if record.exited {
                return false;
            }
            (record.channel.clone(), record.probe.clone())
        };
        let started = Instant::now();
        // OSC 10/11 color-query experiment: log the payload as the backend
        // received it via POST, before it enters the channel queue, so the
        // bytes can be compared with the frontend's http-post line.
        if data.windows(2).any(|bytes| bytes == b"\x1b]") {
            let t = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0);
            crate::debuglog::debug_term(
                "osc",
                id,
                &format!(
                    "hub-write t={t} {}B: {}",
                    data.len(),
                    crate::remote::hex_prefix(data, 512)
                ),
            );
        }
        let ok = channel.write(data);
        let elapsed = started.elapsed().as_millis() as u64;
        let mut probe = lock(&probe);
        probe.writes += 1;
        probe.last_write_ms = elapsed;
        probe.last_write_bytes = data.len();
        if data == b"\x1b[I" {
            probe.last_focus = Some("focused".into());
        } else if data == b"\x1b[O" {
            probe.last_focus = Some("unfocused".into());
        }
        if ok {
            probe.write_ok += 1;
        } else {
            probe.write_err += 1;
            probe.last_error = Some("pty write failed".into());
            crate::debuglog::warn_term("pty", id, "write failed");
        }
        if elapsed >= 200 {
            crate::debuglog::warn_term("pty", id, &format!("write blocked {elapsed}ms"));
        }
        ok
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> bool {
        let (channel, probe) = {
            let map = self.lock();
            let Some(record) = map.get(id) else {
                return false;
            };
            (record.channel.clone(), record.probe.clone())
        };
        let ok = channel.resize(cols, rows);
        let size = channel.size();
        let mut probe = lock(&probe);
        probe.resize_count += 1;
        probe.last_resize_cols = cols;
        probe.last_resize_rows = rows;
        probe.last_resize_ok = ok;
        if let Some((cols, rows)) = size {
            probe.ioctl_cols = Some(cols);
            probe.ioctl_rows = Some(rows);
        }
        if !ok {
            probe.last_error = Some("pty resize failed".into());
            crate::debuglog::warn_term("pty", id, &format!("resize {cols}x{rows} failed"));
        }
        ok
    }

    pub fn probe(&self, id: &str) -> Option<PtyProbe> {
        let map = self.lock();
        let record = map.get(id)?;
        let mut probe = lock(&record.probe).clone();
        probe.backlog_bytes = record.backlog.len();
        probe.offset = record.offset;
        probe.listeners = record.listeners_tx.len();
        probe.replay_dropped_bytes = record.replay_dropped_bytes;
        probe.replay_trimmed = record.replay_trimmed;
        if let Some((cols, rows)) = record.channel.size() {
            probe.ioctl_cols = Some(cols);
            probe.ioctl_rows = Some(rows);
        }
        Some(probe)
    }

    /// Stamps the spawn -> first hook leg on the PTY probe.
    ///
    /// The PTY layer can never observe this itself: hooks arrive as files, not
    /// as bytes, so the harness has to hand the moment back. First write wins —
    /// a resumed card keeps its original number rather than resetting it on
    /// every later hook.
    pub fn record_first_hook(&self, id: &str, at_ms: i64) {
        let map = self.lock();
        let Some(record) = map.get(id) else { return };
        let mut probe = lock(&record.probe);
        if probe.first_hook_ms.is_some() {
            return;
        }
        if let Some(spawned) = probe.spawned_at_ms {
            probe.first_hook_ms = Some(at_ms.max(0) as u64).map(|at| at.saturating_sub(spawned));
        }
    }

    pub fn kill(&self, id: &str) {
        let mut map = self.lock();
        if let Some(mut record) = map.remove(id) {
            let saved = record.persistent.then(|| TerminalTranscript {
                cwd: record.cwd.clone(),
                output: record.backlog.clone(),
                exit_code: record.exit_code,
            });
            if !record.exited {
                record.channel.kill();
            }
            emit(&mut record, TerminalEvent::Closed);
            // Dropping the record drops the channel: a local pty loses its
            // master handle, a remote queue loses its sender and the SSH task
            // tears the channel down.
            drop(map);
            if let Some(saved) = saved {
                save_terminal_transcript(id, &saved);
            }
        }
    }

    pub fn stop(&self, id: &str) {
        let channel = {
            let map = self.lock();
            let Some(record) = map.get(id) else { return };
            if record.exited {
                return;
            }
            record.channel.clone()
        };
        channel.kill();
        let inner = self.inner.clone();
        let id = id.to_string();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(2));
            let map = lock(&inner);
            if let Some(record) = map.get(&id) {
                if !record.exited {
                    record.channel.kill();
                }
            }
        });
    }

    pub fn shutdown(&self) {
        let ids: Vec<String> = self.lock().keys().cloned().collect();
        for id in ids {
            self.kill(&id);
        }
    }

    /// Attaches a listener and returns the catch-up payload.
    ///
    /// Three states, and the distinction matters because they are not
    /// interchangeable to a client that is mid-stream:
    ///
    /// * `after` is inside `[start, offset]` — resumable. Replay exactly the tail
    ///   the client has not seen; `reset` is false and nothing is lost. This is
    ///   the normal reconnect after a pause, and it must survive arbitrarily long
    ///   backgrounding, which is why the backlog is not the only source here.
    /// * `after` is before `start` — the head was trimmed while the client was
    ///   away. We cannot reconstruct the gap, so we replay the backlog and flag
    ///   `dropped` so the loss is *visible* instead of silently swallowed.
    /// * `after` is absent or beyond `offset` — first attach, or a cursor from a
    ///   different session. Full replay, no loss attribution.
    ///
    /// A cursor *beyond* `offset` used to be indistinguishable from a stale one.
    /// It is not: a client can legitimately hold a higher offset than we do after
    /// a backend restart, and forcing a reset there discards its valid buffer.
    pub fn subscribe(
        &self,
        id: &str,
        after: Option<u64>,
    ) -> Option<(
        TerminalEvent,
        mpsc::UnboundedReceiver<TerminalEvent>,
        bool,
        Option<i32>,
    )> {
        let mut map = self.lock();
        if let Some(record) = map.get_mut(id) {
            let (tx, rx) = mpsc::unbounded_channel();
            record.listeners_tx.push(tx);
            record.listeners = record.listeners_tx.len();
            record.last_listener = Instant::now();
            let start = record.offset.saturating_sub(record.backlog.len() as u64);
            // Only a cursor that fell off the *front* forces a reset. A cursor
            // ahead of us keeps the replay semantics and simply yields no new
            // bytes, which `enqueueOutput` handles by skipping.
            let trimmed = after.is_some_and(|cursor| cursor < start);
            let ahead = after.is_some_and(|cursor| cursor > record.offset);
            let reset = after.is_none() || trimmed || ahead;
            let (data, from, dropped) = if reset {
                if trimmed {
                    // Bytes between the client's cursor and our oldest held byte
                    // are gone for good. Report the size of the hole rather than
                    // letting the client believe it is looking at a clean redraw.
                    let cursor = after.unwrap_or(start);
                    let lost = start.saturating_sub(cursor);
                    crate::debuglog::warn_term(
                        "sse",
                        id,
                        &format!("replay trimmed cursor={cursor} start={start} lost={lost}B"),
                    );
                    record.replay_trimmed += 1;
                    record.replay_dropped_bytes = record.replay_dropped_bytes.saturating_add(lost);
                    (record.backlog.clone(), start, Some(lost))
                } else {
                    (record.backlog.clone(), start, None)
                }
            } else {
                let skip = after.unwrap_or(start).saturating_sub(start) as usize;
                let mut index = skip.min(record.backlog.len());
                while index < record.backlog.len() && !record.backlog.is_char_boundary(index) {
                    index += 1;
                }
                (
                    record.backlog[index..].to_string(),
                    start + index as u64,
                    None,
                )
            };
            return Some((
                TerminalEvent::Output {
                    data,
                    from,
                    offset: record.offset,
                    reset: Some(reset),
                    dropped,
                },
                rx,
                record.exited,
                record.exit_code,
            ));
        }
        drop(map);
        let saved = read_terminal_transcript(id)?;
        let (_tx, rx) = mpsc::unbounded_channel();
        Some((
            TerminalEvent::Output {
                data: saved.output.clone(),
                from: 0,
                offset: saved.output.len() as u64,
                reset: Some(true),
                dropped: None,
            },
            rx,
            true,
            saved.exit_code,
        ))
    }

    pub fn release_listener(&self, id: &str) {
        let mut map = self.lock();
        if let Some(record) = map.get_mut(id) {
            record.listeners_tx.retain(|tx| !tx.is_closed());
            record.listeners = record.listeners_tx.len();
            record.last_listener = Instant::now();
        }
    }

    pub fn harness_overlay(&self, _id: &str) -> Option<HarnessSession> {
        None
    }
}

/// Hand one chunk of raw transport bytes to the terminal it belongs to.
///
/// Both transports funnel through here so the local pty thread and the SSH task
/// cannot drift apart on backlog trimming, offset accounting or the dev probes.
fn deliver(
    inner: &Mutex<HashMap<String, Record>>,
    id: &str,
    probe: &Arc<Mutex<PtyProbe>>,
    incoming: &[u8],
) {
    let (data, callback) = {
        let mut map = lock(inner);
        let Some(record) = map.get_mut(id) else {
            return;
        };
        let data = decode_chunk(&mut record.pending, incoming);
        // First transport byte, NOT CLI readiness: ConPTY emits control queries
        // before the application draws anything. Keep this metric distinct from
        // the startup handshake and the harness's first lifecycle event.
        {
            let mut probe = lock(probe);
            probe.chunks += 1;
            probe.bytes_in += incoming.len() as u64;
            if data.is_empty() {
                probe.decode_held += 1;
            } else if probe.first_byte_ms.is_none() {
                let elapsed = probe
                    .spawned_at_ms
                    .map(|at| crate::queue::now_ms().max(0) as u64 - at)
                    .unwrap_or(0);
                probe.first_byte_ms = Some(elapsed);
                crate::debuglog::info_term(
                    "pty",
                    id,
                    &format!("first byte after {elapsed}ms ({} bytes)", incoming.len()),
                );
            }
        }
        if data.is_empty() {
            return;
        }
        if let Some(enabled) = record.theme_notify_parser.feed(data.as_bytes()) {
            record.theme_notify = enabled;
        }
        record.backlog.push_str(&data);
        let from = record.offset;
        record.offset += data.len() as u64;
        trim_backlog(&mut record.backlog);
        if record.persistent {
            record.dirty = true;
        }
        let before = record.listeners_tx.len();
        emit(
            record,
            TerminalEvent::Output {
                data: data.clone(),
                from,
                offset: record.offset,
                reset: None,
                dropped: None,
            },
        );
        {
            let mut probe = lock(probe);
            probe.events_emitted += 1;
            probe.backlog_bytes = record.backlog.len();
            probe.offset = record.offset;
            probe.listeners = record.listeners_tx.len();
            if record.listeners_tx.len() < before {
                probe.send_fail += (before - record.listeners_tx.len()) as u64;
                if probe.send_fail == 1 {
                    crate::debuglog::warn_term("sse", id, "listener dropped while bytes flowing");
                }
            }
        }
        (data, record.on_output.clone())
    };
    if let Some(callback) = callback {
        if catch_unwind(AssertUnwindSafe(|| callback(&data))).is_err() {
            let mut probe = lock(probe);
            probe.on_output_panic += 1;
            probe.last_error = Some("on_output panicked".into());
            crate::debuglog::error_term("pty", id, "on_output panicked");
        }
    }
}

fn spawn_canvas_dark(spawn: &Spawn) -> bool {
    match spawn {
        Spawn::Local { env, .. } => env
            .get("COLORFGBG")
            .map(|value| crate::terminal_theme::is_dark_colorfgbg(value))
            .unwrap_or_else(crate::terminal_theme::app_dark),
        Spawn::Remote { command, .. } => command
            .split("COLORFGBG=")
            .nth(1)
            .map(|rest| {
                let value = rest
                    .trim_start_matches('\'')
                    .split(['\'', ' '])
                    .next()
                    .unwrap_or("");
                crate::terminal_theme::is_dark_colorfgbg(value)
            })
            .unwrap_or_else(crate::terminal_theme::app_dark),
    }
}

fn finalize(
    inner: &Mutex<HashMap<String, Record>>,
    id: &str,
    code: i32,
    live: &LiveBus,
    probe: &Arc<Mutex<PtyProbe>>,
) {
    lock(probe).reader_alive = false;
    crate::debuglog::info_term("pty", id, &format!("exit {code}"));
    let saved = {
        let mut map = lock(inner);
        map.get_mut(id).map(|record| {
            record.exited = true;
            record.exit_code = Some(code);
            record.dirty = false;
            let saved = TerminalTranscript {
                cwd: record.cwd.clone(),
                output: record.backlog.clone(),
                exit_code: record.exit_code,
            };
            emit(record, TerminalEvent::Exit { exit_code: code });
            (record.persistent, saved)
        })
    };
    if let Some((true, saved)) = saved {
        save_terminal_transcript(id, &saved);
    }
    live.notify("terminal");
}

fn emit(record: &mut Record, event: TerminalEvent) {
    record
        .listeners_tx
        .retain(|tx| tx.send(event.clone()).is_ok());
    record.listeners = record.listeners_tx.len();
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|error| error.into_inner())
}

fn decode_chunk(pending: &mut Vec<u8>, incoming: &[u8]) -> String {
    pending.extend_from_slice(incoming);
    match std::str::from_utf8(pending) {
        Ok(text) => {
            let out = text.to_string();
            pending.clear();
            out
        }
        Err(error) => {
            let valid = error.valid_up_to();
            let out = std::str::from_utf8(&pending[..valid])
                .unwrap_or("")
                .to_string();
            if let Some(invalid) = error.error_len() {
                pending.drain(..valid + invalid);
            } else {
                pending.drain(..valid);
            }
            out
        }
    }
}

fn dimension(value: u16, fallback: u16) -> u16 {
    let n = if value < 2 { fallback } else { value };
    n.clamp(2, 1000)
}

fn persist_dirty(inner: &Mutex<HashMap<String, Record>>) {
    let snapshots: Vec<(String, TerminalTranscript)> = {
        let mut map = lock(inner);
        map.iter_mut()
            .filter(|(_, record)| record.persistent && record.dirty)
            .map(|(id, record)| {
                record.dirty = false;
                (
                    id.clone(),
                    TerminalTranscript {
                        cwd: record.cwd.clone(),
                        output: record.backlog.clone(),
                        exit_code: record.exit_code,
                    },
                )
            })
            .collect()
    };
    for (id, saved) in snapshots {
        save_terminal_transcript(&id, &saved);
    }
}

fn trim_backlog(backlog: &mut String) {
    let limit = max_backlog();
    if limit == 0 || backlog.len() <= limit {
        return;
    }
    let mut extra = backlog.len() - limit;
    while extra < backlog.len() && !backlog.is_char_boundary(extra) {
        extra += 1;
    }
    backlog.drain(..extra);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::live::LiveBus;
    use std::sync::Mutex;

    static ENV: Mutex<()> = Mutex::new(());

    #[test]
    fn cwd_and_subscribe_fall_back_to_transcript() {
        let _guard = ENV.lock().unwrap();
        let dir = std::env::temp_dir().join(format!("que-term-{}", uuid::Uuid::new_v4().simple()));
        std::env::set_var("QUE_DATA_DIR", &dir);
        let id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        save_terminal_transcript(
            id,
            &TerminalTranscript {
                cwd: "/work".into(),
                output: "kept\n".into(),
                exit_code: Some(0),
            },
        );
        let hub = TerminalHub::new(LiveBus::new());
        assert_eq!(hub.cwd(id).as_deref(), Some("/work"));
        assert!(hub.snapshot(id).is_none());
        let (output, _, exited, code) = hub.subscribe(id, None).expect("transcript subscribe");
        assert!(exited);
        assert_eq!(code, Some(0));
        match output {
            TerminalEvent::Output { data, reset, .. } => {
                assert_eq!(data, "kept\n");
                assert_eq!(reset, Some(true));
            }
            _ => panic!("expected replayed output"),
        }
        let _ = std::fs::remove_dir_all(dir);
        std::env::remove_var("QUE_DATA_DIR");
    }

    #[test]
    fn decode_chunk_holds_incomplete_utf8() {
        let mut pending = Vec::new();
        let bytes = "你好".as_bytes();
        assert!(decode_chunk(&mut pending, &bytes[..1]).is_empty());
        assert_eq!(decode_chunk(&mut pending, &bytes[1..]), "你好");
        assert!(pending.is_empty());
    }

    /// The two transports must agree on how a chunk reaches the front end, so
    /// pin the shared ingest path rather than either transport's plumbing.
    #[test]
    fn deliver_merges_split_utf8_across_chunks() {
        let hub = TerminalHub::new(LiveBus::new());
        let id = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        let probe = Arc::new(Mutex::new(PtyProbe {
            reader_alive: true,
            ..PtyProbe::default()
        }));
        hub.register(
            id.to_string(),
            "/work".into(),
            false,
            None,
            Arc::new(NoopChannel),
            probe.clone(),
            false,
            false,
        );
        let bytes = "你好".as_bytes();
        deliver(&hub.inner, id, &probe, &bytes[..1]);
        assert_eq!(hub.snapshot(id).map(|s| s.output), Some(String::new()));
        deliver(&hub.inner, id, &probe, &bytes[1..]);
        assert_eq!(hub.snapshot(id).map(|s| s.output), Some("你好".into()));
    }

    struct NoopChannel;

    impl Channel for NoopChannel {
        fn write(&self, _data: &[u8]) -> bool {
            false
        }
        fn resize(&self, _cols: u16, _rows: u16) -> bool {
            false
        }
        fn size(&self) -> Option<(u16, u16)> {
            None
        }
        fn kill(&self) {}
    }

    struct CaptureChannel(Mutex<Vec<u8>>);

    impl Channel for CaptureChannel {
        fn write(&self, data: &[u8]) -> bool {
            lock(&self.0).extend_from_slice(data);
            true
        }
        fn resize(&self, _cols: u16, _rows: u16) -> bool {
            false
        }
        fn size(&self) -> Option<(u16, u16)> {
            None
        }
        fn kill(&self) {}
    }

    #[test]
    fn apply_canvas_dark_notifies_live_sessions() {
        let hub = TerminalHub::new(LiveBus::new());
        let id = "dddddddddddddddddddddddddddddddd";
        let probe = Arc::new(Mutex::new(PtyProbe {
            reader_alive: true,
            ..PtyProbe::default()
        }));
        let channel = Arc::new(CaptureChannel(Mutex::new(Vec::new())));
        hub.register(
            id.to_string(),
            "/work".into(),
            false,
            None,
            channel.clone(),
            probe.clone(),
            false,
            false,
        );
        deliver(&hub.inner, id, &probe, b"\x1b[?2031h");
        hub.apply_canvas_dark(true);
        let report = String::from_utf8(lock(&channel.0).clone()).unwrap();
        assert_eq!(report, "\x1b[?997;1n");
        lock(&channel.0).clear();
        hub.apply_canvas_dark(false);
        assert_eq!(
            String::from_utf8(lock(&channel.0).clone()).unwrap(),
            "\x1b[?997;2n"
        );
        lock(&channel.0).clear();
        hub.apply_canvas_theme(false, true);
        assert_eq!(
            String::from_utf8(lock(&channel.0).clone()).unwrap(),
            "\x1b[?997;2n"
        );
    }

    #[test]
    fn a_cli_that_never_subscribed_2031_gets_no_theme_report() {
        let hub = TerminalHub::new(LiveBus::new());
        let id = "cccccccccccccccccccccccccccccc99";
        let probe = Arc::new(Mutex::new(PtyProbe {
            reader_alive: true,
            ..PtyProbe::default()
        }));
        let channel = Arc::new(CaptureChannel(Mutex::new(Vec::new())));
        hub.register(
            id.to_string(),
            "/work".into(),
            false,
            None,
            channel.clone(),
            probe,
            false,
            false,
        );
        hub.apply_canvas_dark(true);
        hub.apply_canvas_theme(true, true);
        assert!(
            lock(&channel.0).is_empty(),
            "a 997 report without a DECSET 2031 subscription leaks onto the prompt"
        );
    }

    #[test]
    fn a_campbell_canvas_stays_pinned_to_dark() {
        let hub = TerminalHub::new(LiveBus::new());
        let id = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
        let probe = Arc::new(Mutex::new(PtyProbe {
            reader_alive: true,
            ..PtyProbe::default()
        }));
        let channel = Arc::new(CaptureChannel(Mutex::new(Vec::new())));
        hub.register(
            id.to_string(),
            "/work".into(),
            false,
            None,
            channel.clone(),
            probe.clone(),
            true,
            true,
        );
        deliver(&hub.inner, id, &probe, b"\x1b[?2031h");
        hub.apply_canvas_dark(false);
        hub.apply_canvas_theme(false, true);
        assert!(
            lock(&channel.0).is_empty(),
            "a Campbell canvas does not follow the app theme"
        );
    }

    /// The whole translation between the hub's synchronous write/resize/kill and
    /// the SSH task's queue. A side terminal on a remote host goes through this
    /// and nothing else.
    #[test]
    fn a_remote_channel_forwards_writes_sizes_and_the_close() {
        let (commands, mut queue) = mpsc::unbounded_channel();
        let channel = RemoteChannel {
            commands,
            size: Mutex::new((80, 24)),
            closed: AtomicBool::new(false),
        };

        assert_eq!(channel.size(), Some((80, 24)));
        assert!(channel.write(b"ls\r"));
        assert!(channel.resize(120, 40));
        assert_eq!(channel.size(), Some((120, 40)));
        assert!(channel.write("\u{4f60}\u{597d}".as_bytes()));

        // A killed channel stops accepting input — the pane is gone — but still
        // tells the SSH task to close, so the remote shell cannot outlive it.
        channel.kill();
        assert!(!channel.write(b"stale"));

        let mut seen = Vec::new();
        while let Ok(command) = queue.try_recv() {
            seen.push(command);
        }
        assert_eq!(seen.len(), 4);
        assert!(matches!(seen[0], PtyCommand::Data(ref data) if data == b"ls\r"));
        assert!(matches!(seen[1], PtyCommand::Resize(120, 40)));
        assert!(
            matches!(seen[2], PtyCommand::Data(ref data) if data == "\u{4f60}\u{597d}".as_bytes())
        );
        assert!(matches!(seen[3], PtyCommand::Close));
    }

    #[test]
    fn trim_backlog_respects_capacity_and_utf8_boundaries() {
        let mut text = "a".repeat(100);
        trim_backlog(&mut text);
        assert_eq!(text.len(), 100);

        // Test with QUE_TERMINAL_BACKLOG_BYTES override
        std::env::set_var("QUE_TERMINAL_BACKLOG_BYTES", "10");
        let mut sample = format!("hello world {}", "你好世界");
        trim_backlog(&mut sample);
        assert!(sample.len() <= 10);
        assert!(std::str::from_utf8(sample.as_bytes()).is_ok());

        // Test with 0 = unlimited
        std::env::set_var("QUE_TERMINAL_BACKLOG_BYTES", "0");
        let mut huge = "x".repeat(1000);
        trim_backlog(&mut huge);
        assert_eq!(huge.len(), 1000);

        std::env::remove_var("QUE_TERMINAL_BACKLOG_BYTES");
    }
}
