//! Codex: persistent MCP lifecycle hooks, a TUI title probe,
//! and a rollout-file session store.

use super::label_text::{json_text, SessionLabel};
use super::registry::{checked_id, Adapter, Ctx, GlobalCtx, Harness, Plan};
use super::session_find::{find_all, find_first, safe_name_id};
use super::session_label::SessionFacts;
use crate::error::{AppError, AppResult};
use crate::paths::atomic_write;
use crate::winproc::NoWindow;
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Mutex;
use std::time::SystemTime;

const EVENTS: &[&str] = &[
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PermissionRequest",
    "PostToolUse",
    "Stop",
];

/// Pin the TUI to the title and notification channel Que reads back.
const ARGS: &[&str] = &[
    "-c",
    r#"tui.terminal_title=["app-name","status","spinner","session-id"]"#,
    "-c",
    r#"tui.notifications=["plan-mode-prompt","approval-requested"]"#,
    "-c",
    r#"tui.notification_method="osc9""#,
    "-c",
    r#"tui.notification_condition="always""#,
];

/// Codex wants the full rollout uuid back, not just any session id.
fn resume_args(session_id: &str) -> AppResult<Vec<String>> {
    let id = checked_id(session_id)?;
    if !regex::Regex::new(r"^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$")
        .unwrap()
        .is_match(id)
    {
        return Err(AppError::machine("HARNESS_SESSION_ID_INVALID"));
    }
    Ok(vec!["resume".into(), id.into()])
}

async fn plan(ctx: Ctx<'_>, events: &'static [&'static str]) -> AppResult<Plan> {
    let mut plan = Plan::default();
    plan.files.insert(
        "codex-mcp.cjs".into(),
        std::fs::read_to_string(ctx.bin_dir.join("harness-codex-mcp.cjs"))?,
    );
    let server = mcp_server(&ctx.host.node, &ctx.host.relative("codex-mcp.cjs"));
    plan.args.extend([
        "--enable".into(),
        "hooks".into(),
        "-c".into(),
        format!("mcp_servers.que_session_state={server}"),
    ]);
    for &event in events {
        plan.args.extend([
            "-c".into(),
            format!(
                "hooks.{event}=[{{hooks=[{}]}}]",
                scoped_mcp_handler(event, "internal")
            ),
        ]);
    }
    Ok(plan)
}

pub struct Codex;

pub static CODEX: Codex = Codex;

fn mcp_server(node: &str, script: &str) -> String {
    format!(
        "{{command={},args=[{}],env_vars={}}}",
        serde_json::to_string(node).unwrap(),
        serde_json::to_string(script).unwrap(),
        MCP_ENV
    )
}

// Codex filters the MCP child environment; card routing is not inherited unless
// explicitly forwarded. Without this, internal events become external notices.
const MCP_ENV: &str = r#"["QUE_HARNESS_SIGNAL_DIR","QUE_HARNESS_CHANNEL","QUE_HARNESS_KIND","QUE_HARNESS_TTY","QUE_HARNESS_TMUX_SESSION","TMUX","QUE_EXTERNAL_SIGNAL_DIR","QUE_HOOK_DEBUG","QUE_HOOK_DEBUG_FILE"]"#;

fn mcp_handler(event: &str) -> String {
    mcp_handler_for(event, "que_session_state")
}

fn mcp_handler_for(event: &str, server: &str) -> String {
    // Event-specific fields avoid unresolved templates on events lacking them.
    let mut fields = String::from(r#"session_id="${session_id}",cwd="${cwd}""#);
    if event == "UserPromptSubmit" {
        fields.push_str(r#",prompt="${prompt}""#);
    }
    if matches!(event, "PreToolUse" | "PermissionRequest" | "PostToolUse") {
        fields.push_str(r#",tool_name="${tool_name}""#);
    }
    if event == "Stop" {
        fields.push_str(r#",last_assistant_message="${last_assistant_message}""#);
    }
    format!(
        r#"{{ type = "mcp_tool", server = "{server}", tool = "session_state", input = {{hook_event_name="{event}",{fields}}}, timeout = 5 }}"#
    )
}

fn scoped_mcp_handler(event: &str, scope: &str) -> String {
    mcp_handler(event).replace("input = {", &format!("input = {{que_scope=\"{scope}\","))
}

fn profile_registration(owner: &str, server: &str) -> String {
    let mut block = format!("\n# Que session state hook {owner}\n");
    for event in EVENTS {
        let handler =
            mcp_handler_for(event, server).replace("input = {", "input = {que_scope=\"external\",");
        block.push_str(&format!("[[hooks.{event}]]\nhooks = [{handler}]\n"));
    }
    block
}

fn profile_transport(ctx: &GlobalCtx, owner: &str, server: &str) -> String {
    let script = ctx.plugins.join("codex/codex-mcp.cjs");
    format!("\n# Que persistent Codex hook transport {owner}\n[mcp_servers.{server}]\ncommand = {}\nargs = [{}]\nenv_vars = {MCP_ENV}\n# End Que persistent Codex hook transport {owner}\n",
        serde_json::to_string(&ctx.node).unwrap(),
        serde_json::to_string(&script.to_string_lossy()).unwrap())
}

fn legacy_transport_owned(config: &str, ctx: &GlobalCtx) -> bool {
    let Some(start) = config.find(&format!("{MCP_MARKER}\n")) else {
        return false;
    };
    let Some(end) = config[start..].find(MCP_END).map(|at| start + at) else {
        return false;
    };
    let block = config[start..end].replace("\\\\", "/").replace('\\', "/");
    block.contains("[mcp_servers.que_session_state]")
        && block.contains(
            &ctx.plugins
                .join("codex/codex-mcp.cjs")
                .to_string_lossy()
                .replace('\\', "/"),
        )
}

fn legacy_direct_owned(config: &str, ctx: &GlobalCtx) -> bool {
    let lines: Vec<&str> = config.lines().collect();
    let Some(start) = lines.iter().position(|line| {
        matches!(
            line.trim(),
            "# Que session state hook" | "# Cue session state hook"
        )
    }) else {
        return false;
    };
    let block = lines[start + 1..]
        .iter()
        .take_while(|line| {
            let line = line.trim();
            line.is_empty()
                || line.starts_with("[[hooks.")
                || line.starts_with("[hooks.")
                || line.starts_with("hooks = [")
        })
        .copied()
        .collect::<Vec<_>>()
        .join("\n")
        .replace("\\\\", "/")
        .replace('\\', "/");
    block.contains(&ctx.hook_path("codex").replace('\\', "/"))
}

const MCP_MARKER: &str = "# Que persistent Codex hook transport";
const MCP_END: &str = "# End Que persistent Codex hook transport";

fn strip_mcp_server(config: &str) -> String {
    let Some(start) = config.find(&format!("{MCP_MARKER}\n")) else {
        return config.into();
    };
    let Some(end) = config[start..]
        .find(MCP_END)
        .map(|i| start + i + MCP_END.len())
    else {
        return config.into();
    };
    let block = &config[start..end];
    // Only remove our single server table, never adjacent or user-renamed tables.
    if !block.contains("[mcp_servers.que_session_state]\n")
        || block.lines().filter(|line| line.starts_with('[')).count() != 1
        || ![
            "harness-plugins/codex/codex-mcp.cjs",
            "harness-plugins/codex/que-hook.exe",
        ]
        .iter()
        .any(|marker| {
            block
                .replace("\\\\", "/")
                .replace('\\', "/")
                .contains(marker)
        })
    {
        return config.into();
    }
    format!("{}{}", &config[..start], &config[end..])
}

/// Bypass only the official npm shim. cmd's parsing of `%*` cannot preserve
/// nested TOML quotes and operators in `-c` overrides. Keep the JS entrypoint
/// (rather than guessing its native binary) so upstream environment setup runs.
pub(crate) fn npm_entrypoint(shim: &str) -> Option<PathBuf> {
    if !shim.to_ascii_lowercase().ends_with(".cmd") {
        return None;
    }
    let body = std::fs::read_to_string(shim).ok()?.replace('\\', "/");
    if !body.contains("%dp0%/node_modules/@openai/codex/bin/codex.js") {
        return None;
    }
    let script = std::path::Path::new(shim)
        .parent()?
        .join("node_modules/@openai/codex/bin/codex.js");
    script.is_file().then_some(script)
}

impl Harness for Codex {
    fn id(&self) -> &'static str {
        "codex"
    }
    fn adapter(&self) -> Option<Adapter> {
        Some(Adapter::new("codex", ARGS, resume_args))
    }

    /// The ingress path is written into the config markers, so every install of the
    /// same script version must land at the same address: the cache dir carries the
    /// digest, not the card's token.
    fn remote_root(&self, home: &str, _token: &str, ingress_sha: &str) -> String {
        format!("{home}/.cache/que/harness-plugins/codex/{ingress_sha}")
    }

    fn events(&self) -> &'static [&'static str] {
        EVENTS
    }

    fn plan<'a>(
        &'a self,
        ctx: Ctx<'a>,
    ) -> Pin<Box<dyn Future<Output = AppResult<Plan>> + Send + 'a>> {
        Box::pin(plan(ctx, self.events()))
    }

    /// Register a persistent lifecycle sink for ordinary external sessions.
    fn global(&self, ctx: &GlobalCtx) {
        let _ = ctx.install_ingress("codex");
        let dir = std::env::var("CODEX_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| ctx.home.join(".codex"));
        if !dir.exists() {
            return;
        }
        let config = dir.join("config.toml");
        let mut existing = std::fs::read_to_string(&config).unwrap_or_default();
        let owner = ctx.profile_id();
        let server = format!("que_session_state_{owner}");
        let registration = profile_registration(&owner, &server);
        let transport = profile_transport(ctx, &owner, &server);
        // A changed block may contain user edits. Do not replace it by matching a
        // generic Que marker, which might belong to another running profile.
        if (existing.contains(&format!("# Que session state hook {owner}"))
            && !existing.contains(&registration))
            || (existing.contains(&format!("# Que persistent Codex hook transport {owner}"))
                && !existing.contains(&transport))
        {
            return;
        }
        existing = existing.replace(&registration, "").replace(&transport, "");
        // Migrate the old single-server registration only when its script belongs
        // to this data directory. A second Que profile may still own that name.
        if legacy_transport_owned(&existing, ctx) || legacy_direct_owned(&existing, ctx) {
            let repaired = repair_headers(&existing, self.events());
            let stripped = strip_registration(&repaired, self.events());
            if stripped == repaired {
                return;
            }
            existing = if legacy_transport_owned(&existing, ctx) {
                strip_mcp_server(&stripped)
            } else {
                stripped
            };
        }
        // Rebuild only the complete owned block so quoting/runtime fixes also
        // reach previously registered external sessions.
        let mut to_append = String::new();
        let existing = if existing.contains("[features]") {
            // The user already has a [features] table. Appending a second one is
            // invalid TOML, and without `hooks = true` the registration block
            // below does nothing — Que-launched sessions can turn the feature
            // on with `--enable hooks`, but external sessions only read this
            // file, so the flag has to live in the user's own table.
            enable_hooks_feature(&existing)
        } else {
            to_append.push_str("\n[features]\nhooks = true\n");
            existing
        };
        let use_mcp = !existing.contains(&format!("[mcp_servers.{server}]"))
            && ctx
                .install_plugin("codex", "harness-codex-mcp.cjs", "codex-mcp.cjs")
                .is_ok();
        if use_mcp {
            to_append.push_str(&registration);
            to_append.push_str(&transport);
        } else {
            return; // Preserve a conflicting user server or a failed installation.
        }
        // The user's own config, written atomically: a torn write here costs them every
        // Codex session, not just Que's entries.
        let _ = atomic_write(&config, &format!("{existing}\n{to_append}"));
    }

    fn title_probe(&self) -> bool {
        true
    }

    fn resolve_session_prefix(&self, prefix: &str) -> Option<String> {
        resolve_codex_session_prefix(prefix)
    }

    fn exit_session_id(&self, read_output: &dyn Fn() -> Option<String>) -> Option<String> {
        codex_exit_session_id(&read_output()?)
    }

    /// Strip the block `global` appended — the settings toggle's other half. Only
    /// Que's own groups are removed; user-written `[[hooks.*]]` and everything
    /// else in the file survive byte for byte.
    fn unglobal(&self, ctx: &GlobalCtx) {
        let dir = std::env::var("CODEX_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| ctx.home.join(".codex"));
        let config = dir.join("config.toml");
        let Ok(existing) = std::fs::read_to_string(&config) else {
            return;
        };
        let owner = ctx.profile_id();
        let server = format!("que_session_state_{owner}");
        let mut cleaned = existing
            .replace(&profile_registration(&owner, &server), "")
            .replace(&profile_transport(ctx, &owner, &server), "");
        if legacy_transport_owned(&cleaned, ctx) || legacy_direct_owned(&cleaned, ctx) {
            let stripped = strip_registration(&cleaned, self.events());
            if stripped != cleaned {
                cleaned = if legacy_transport_owned(&cleaned, ctx) {
                    strip_mcp_server(&stripped)
                } else {
                    stripped
                };
            }
        }
        if cleaned != existing {
            let _ = atomic_write(&config, &cleaned);
        }
    }

    fn external_ingress(&self) -> bool {
        true
    }

    // —— the session store ——

    fn session_exists(&self, id: &str) -> Option<bool> {
        codex_session_exists(id)
    }
    fn session_label(&self, id: &str, need_first_prompt: bool) -> Option<SessionLabel> {
        Some(session_label(id, need_first_prompt))
    }
    fn session_details(&self, id: &str) -> Option<SessionFacts> {
        codex_session_details(id).map(|details| SessionFacts {
            name: details.title,
            cwd: details.cwd,
            prompt: details.prompt,
            reply: details.reply,
            turns: details.turns,
        })
    }
}

// —— the title probe ——

pub struct CodexTitleProbe {
    pending: String,
    pub session_id: Option<String>,
    pub session_id_prefix: Option<String>,
    needs_input: bool,
    last_state: Option<String>,
}

impl CodexTitleProbe {
    pub fn new() -> Self {
        Self {
            pending: String::new(),
            session_id: None,
            session_id_prefix: None,
            needs_input: false,
            last_state: None,
        }
    }

    pub fn consume_needs_input(&mut self) -> bool {
        let waiting = self.needs_input;
        self.needs_input = false;
        waiting
    }

    pub fn push(&mut self, data: &str) -> Option<String> {
        self.pending.push_str(data);
        let mut state = None;
        loop {
            let Some(start) = self.pending.find("\x1b]") else {
                self.pending = if self.pending.ends_with('\x1b') {
                    "\x1b".into()
                } else {
                    String::new()
                };
                break;
            };
            self.pending = self.pending[start..].to_string();
            let bel = self.pending.find('\u{7}');
            let st = self.pending.find("\x1b\\");
            let end = match (bel, st) {
                (Some(a), Some(b)) if a <= b => Some((a, 1)),
                (Some(a), None) => Some((a, 1)),
                (None, Some(b)) => Some((b, 2)),
                _ => None,
            };
            let Some((end, term_len)) = end else {
                if self.pending.len() > 4096 {
                    self.pending.clear();
                }
                break;
            };
            let osc = self.pending[2..end].to_string();
            self.pending = self.pending[end + term_len..].to_string();
            if osc.starts_with("9;") {
                self.needs_input = true;
                state = Some("attention".into());
                continue;
            }
            if !osc.starts_with("0;") && !osc.starts_with("2;") {
                continue;
            }
            let title = &osc[2..];
            if !regex::Regex::new(r"^(?:\[ ! \] Action Required(?: \|)? )?codex(?:\s|$)")
                .unwrap()
                .is_match(title)
            {
                continue;
            }
            self.session_id_prefix = regex::Regex::new(
                r"\b([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{5})\.\.\.",
            )
            .unwrap()
            .captures(title)
            .map(|c| c[1].to_string());
            self.session_id = regex::Regex::new(
                r"\b[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b",
            )
            .unwrap()
            .find(title)
            .map(|m| m.as_str().to_string());
            if title.contains("Action Required") {
                self.needs_input = true;
                state = Some("attention".into());
            } else if regex::Regex::new(r"\b(Working|Thinking|Waiting)\b")
                .unwrap()
                .is_match(title)
            {
                state = Some("working".into());
            } else if regex::Regex::new(r"\bReady\b").unwrap().is_match(title) {
                state = Some("attention".into());
            } else if regex::Regex::new(r"\bStarting\b").unwrap().is_match(title) {
                state = Some("starting".into());
            } else {
                state = Some("unknown".into());
            }
        }
        match state {
            Some(next) if self.last_state.as_ref() != Some(&next) => {
                self.last_state = Some(next.clone());
                Some(next)
            }
            _ => None,
        }
    }
}

// —— the session store ——

struct TitleCache {
    path: PathBuf,
    stamp: String,
    titles: HashMap<String, String>,
    days: HashMap<String, String>,
}

static TITLES: Mutex<Option<TitleCache>> = Mutex::new(None);

fn codex_home() -> PathBuf {
    if let Ok(path) = std::env::var("CODEX_HOME") {
        return PathBuf::from(path);
    }
    crate::paths::user_home()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".codex")
}

fn load_titles() {
    let path = codex_home().join("session_index.jsonl");
    let stamp = std::fs::metadata(&path)
        .ok()
        .and_then(|info| info.modified().ok())
        .and_then(|time| time.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| {
            format!(
                "{}:{}",
                d.as_millis(),
                std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0)
            )
        })
        .unwrap_or_default();
    let mut cache = TITLES.lock().unwrap_or_else(|error| error.into_inner());
    if cache
        .as_ref()
        .is_some_and(|c| c.path == path && c.stamp == stamp)
    {
        return;
    }
    let (titles, days) = std::fs::read_to_string(&path)
        .ok()
        .map(|body| parse_index(&body))
        .unwrap_or_default();
    *cache = Some(TitleCache {
        path,
        stamp,
        titles,
        days,
    });
}

fn parse_index(body: &str) -> (HashMap<String, String>, HashMap<String, String>) {
    let mut titles = HashMap::new();
    let mut days = HashMap::new();
    for line in body.lines() {
        let Ok(entry) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let Some(id) = entry.get("id").and_then(|v| v.as_str()) else {
            continue;
        };
        if let Some(name) = entry
            .get("thread_name")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            titles.insert(id.to_string(), name.to_string());
        }
        if let Some(day) = entry
            .get("updated_at")
            .and_then(|v| v.as_str())
            .and_then(index_day)
        {
            days.insert(id.to_string(), day);
        }
    }
    (titles, days)
}

fn index_day(updated_at: &str) -> Option<String> {
    let day = updated_at.get(..10)?;
    if day.as_bytes().get(4) == Some(&b'-') && day.as_bytes().get(7) == Some(&b'-') {
        Some(day.to_string())
    } else {
        None
    }
}

fn codex_exit_session_id(output: &str) -> Option<String> {
    let stripped = regex::Regex::new(r"\x1b\[[0-?]*[ -/]*[@-~]")
        .unwrap()
        .replace_all(output, "");
    regex::Regex::new(r"(?i)\x1b\]0;(?:\x07|\x1b\\)Session ID: ([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\r?\n\s*$")
        .unwrap()
        .captures(&stripped)
        .map(|caps| caps[1].to_string())
}

fn session_label(session_id: &str, need_first_prompt: bool) -> SessionLabel {
    SessionLabel {
        name: codex_session_title(session_id),
        first_prompt: if need_first_prompt {
            first_user_prompt(session_id)
        } else {
            None
        },
    }
}

fn codex_session_title(session_id: &str) -> Option<String> {
    load_titles();
    TITLES
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .as_ref()?
        .titles
        .get(session_id)
        .cloned()
}

fn first_user_prompt(session_id: &str) -> Option<String> {
    first_user_from_rollout(&std::fs::read_to_string(locate_rollout(session_id)?).ok()?)
}

fn locate_rollout(session_id: &str) -> Option<PathBuf> {
    if !safe_name_id(session_id) {
        return None;
    }
    if let Some(path) = sqlite_rollout_path(session_id).filter(|path| path.is_file()) {
        return Some(path);
    }
    load_titles();
    let home = codex_home();
    let day = TITLES
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .as_ref()
        .and_then(|cache| cache.days.get(session_id).cloned());
    if let Some(day) = day {
        let y = &day[..4];
        let m = &day[5..7];
        let d = &day[8..10];
        let suffix = format!("{session_id}.jsonl");
        for directory in ["sessions", "archived_sessions"] {
            let folder = home.join(directory).join(y).join(m).join(d);
            let Ok(entries) = std::fs::read_dir(folder) else {
                continue;
            };
            if let Some(path) = entries.flatten().map(|entry| entry.path()).find(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.ends_with(&suffix))
            }) {
                return Some(path);
            }
        }
    }
    find_first(
        &[home.join("sessions"), home.join("archived_sessions")],
        &format!("*{session_id}.jsonl"),
    )
}

fn sqlite_rollout_path(session_id: &str) -> Option<PathBuf> {
    let db = codex_home().join("state_5.sqlite");
    if !db.exists() {
        return None;
    }
    let output = std::process::Command::new("sqlite3")
        .args([
            "-readonly",
            db.to_str()?,
            &format!("select rollout_path from threads where id='{session_id}'"),
        ])
        .no_window()
        .output()
        .ok()?;
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if path.is_empty() {
        None
    } else {
        Some(PathBuf::from(path))
    }
}

fn first_user_from_rollout(body: &str) -> Option<String> {
    for line in body.lines() {
        let Ok(entry) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if entry.get("type").and_then(|v| v.as_str()) != Some("response_item") {
            continue;
        }
        let Some(payload) = entry.get("payload") else {
            continue;
        };
        if payload.get("role").and_then(|v| v.as_str()) != Some("user") {
            continue;
        }
        if let Some(text) = json_text(payload.get("content").unwrap_or(payload)) {
            return Some(text);
        }
    }
    None
}

fn resolve_codex_session_prefix(prefix: &str) -> Option<String> {
    if !regex::Regex::new(r"(?i)^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{5}$")
        .unwrap()
        .is_match(prefix)
    {
        return None;
    }
    load_titles();
    let mut matches = HashSet::new();
    if let Some(cache) = TITLES
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .as_ref()
    {
        matches.extend(
            cache
                .titles
                .keys()
                .chain(cache.days.keys())
                .filter(|id| id.starts_with(prefix))
                .cloned(),
        );
    }
    if matches.len() == 1 {
        return matches.into_iter().next();
    }
    let home = codex_home();
    let uuid = regex::Regex::new(
        r"(?i)([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.jsonl$",
    )
    .unwrap();
    for path in find_all(
        &[home.join("sessions"), home.join("archived_sessions")],
        &format!("*{prefix}*.jsonl"),
    ) {
        if let Some(caps) = path
            .file_name()
            .and_then(|name| name.to_str())
            .and_then(|name| uuid.captures(name))
        {
            matches.insert(caps[1].to_string());
        }
    }
    if matches.len() == 1 {
        matches.into_iter().next()
    } else {
        None
    }
}

fn codex_session_exists(id: &str) -> Option<bool> {
    if !valid_codex_session_id(id) {
        return None;
    }
    Some(locate_rollout(id).is_some())
}

fn valid_codex_session_id(id: &str) -> bool {
    regex::Regex::new(r"(?i)^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$")
        .unwrap()
        .is_match(id)
}

pub(crate) fn session_label_in(
    id: &str,
    env: &std::collections::HashMap<String, String>,
) -> SessionLabel {
    let Some(home) = env.get("CODEX_HOME") else {
        return session_label(id, true);
    };
    if !safe_name_id(id) {
        return SessionLabel::default();
    }
    let home = PathBuf::from(home);
    let name = std::fs::read_to_string(home.join("session_index.jsonl"))
        .ok()
        .and_then(|body| parse_index(&body).0.remove(id));
    let first_prompt = find_all(
        &[home.join("sessions"), home.join("archived_sessions")],
        &format!("*{id}.jsonl"),
    )
    .into_iter()
    .next()
    .and_then(|path| std::fs::read_to_string(path).ok())
    .and_then(|body| first_user_from_rollout(&body));
    SessionLabel { name, first_prompt }
}

#[derive(Debug, Clone, Default)]
pub struct CodexSessionDetails {
    pub title: Option<String>,
    pub cwd: Option<String>,
    pub prompt: Option<String>,
    pub reply: Option<String>,
    pub turns: Vec<crate::models::ExternalTurn>,
}

fn extract_rollout_text(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::String(s) => {
            let t = s.trim();
            if t.is_empty() {
                None
            } else {
                Some(t.to_string())
            }
        }
        serde_json::Value::Array(items) => {
            let mut parts = Vec::new();
            for item in items {
                if let Some(text) = item.get("text").and_then(|v| v.as_str()) {
                    let trimmed = text.trim();
                    if !trimmed.is_empty() {
                        parts.push(trimmed.to_string());
                    }
                } else if let Some(text) = extract_rollout_text(item) {
                    parts.push(text);
                }
            }
            if parts.is_empty() {
                None
            } else {
                Some(parts.join("\n\n"))
            }
        }
        serde_json::Value::Object(map) => {
            if let Some(text) = map.get("text").and_then(|v| v.as_str()) {
                let trimmed = text.trim();
                if !trimmed.is_empty() {
                    return Some(trimmed.to_string());
                }
            }
            if let Some(content) = map.get("content") {
                return extract_rollout_text(content);
            }
            None
        }
        _ => None,
    }
}

fn codex_session_details(session_id: &str) -> Option<CodexSessionDetails> {
    let path = locate_rollout(session_id)?;
    let body = std::fs::read_to_string(path).ok()?;
    let mut cwd = None;
    let mut turns = Vec::new();
    let mut last_user = None;
    let mut last_assistant = None;

    for line in body.lines() {
        let Ok(entry) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let entry_type = entry.get("type").and_then(|v| v.as_str());
        if entry_type == Some("session_meta") {
            if let Some(payload) = entry.get("payload") {
                if let Some(c) = payload.get("cwd").and_then(|v| v.as_str()) {
                    cwd = Some(c.to_string());
                }
            } else if let Some(c) = entry.get("cwd").and_then(|v| v.as_str()) {
                cwd = Some(c.to_string());
            }
            continue;
        }
        if entry_type == Some("response_item") {
            let Some(payload) = entry.get("payload") else {
                continue;
            };
            let Some(role) = payload.get("role").and_then(|v| v.as_str()) else {
                continue;
            };
            if role != "user" && role != "assistant" {
                continue;
            }
            let raw_content = payload.get("content").unwrap_or(payload);
            let text = extract_rollout_text(raw_content);
            let Some(text) = text else { continue };
            if role == "user" {
                if super::label_text::is_noise(&text) {
                    continue;
                }
                last_user = Some(text.clone());
                turns.push(crate::models::ExternalTurn {
                    role: "user".into(),
                    text,
                });
            } else if role == "assistant" {
                last_assistant = Some(text.clone());
                turns.push(crate::models::ExternalTurn {
                    role: "assistant".into(),
                    text,
                });
            }
        }
    }

    Some(CodexSessionDetails {
        title: codex_session_title(session_id),
        cwd,
        prompt: last_user,
        reply: last_assistant,
        turns,
    })
}

/// The hooks Que registers, in the shape Codex parses.
///
/// Every event is an **array of matcher groups** — `[[hooks.PreToolUse]]` — and not a
/// table. With a single-bracket header the event key holds a map where Codex wants a
/// sequence, which it reports as `invalid type: map, expected a sequence in 'hooks'`
/// and treats as a reason to reject the *whole* config file.
#[cfg(test)]
fn registration_block(cmd: &str, events: &'static [&'static str], timeout: u32) -> String {
    let mut out = String::from("\n# Que session state hook\n");
    for &event in events {
        out.push_str(&format!("[[hooks.{event}]]\nhooks = [{{ type = \"command\", command = {:?}, timeout = {timeout} }}]\n", cmd));
    }
    out
}

/// Turn `hooks = true` on inside an existing `[features]` table, inserting the
/// line right after its header when missing. Only the first plain `[features]`
/// header counts; subtables (`[features.x]`) and other tables are left alone.
/// No-op when the flag is already set anywhere in that table.
fn enable_hooks_feature(config: &str) -> String {
    let lines: Vec<&str> = config.split_inclusive('\n').collect();
    let mut in_features = false;
    let mut enabled = false;
    for line in &lines {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            in_features = trimmed == "[features]";
            continue;
        }
        if in_features && trimmed.split('=').next().map(str::trim) == Some("hooks") {
            enabled = true;
        }
    }
    if enabled {
        return config.to_string();
    }
    let mut out = String::with_capacity(config.len() + "hooks = true\n".len());
    let mut inserted = false;
    for line in &lines {
        out.push_str(line);
        if !inserted {
            let trimmed = line.trim_end();
            if trimmed == "[features]" {
                out.push_str("hooks = true\n");
                inserted = true;
            }
        }
    }
    if inserted {
        out
    } else {
        config.to_string()
    }
}

/// Remove the block `registration_block` appended. The block is contiguous: the
/// marker comment, then one group per event — a `[[hooks.<Event>]]` header (each
/// event at most once) and a single `hooks = [` body line, blank lines between.
/// Removal only commits when **every** event was found: a group Que did not
/// write (a user's own `[[hooks.Stop]]` directly after the block, say) ends the
/// scan and is kept, and an incomplete block is left completely untouched.
fn strip_registration(config: &str, events: &[&str]) -> String {
    let lines: Vec<&str> = config.split_inclusive('\n').collect();
    let Some(marker) = lines.iter().position(|line| {
        matches!(
            line.trim(),
            "# Que session state hook" | "# Cue session state hook"
        )
    }) else {
        return config.to_string();
    };
    let mut seen: Vec<&str> = Vec::new();
    let mut expecting_body = false;
    let mut end = marker + 1;
    while end < lines.len() {
        let trimmed = lines[end].trim_end();
        if trimmed.is_empty() {
            end += 1;
            continue;
        }
        if !expecting_body {
            let event = trimmed
                .strip_prefix("[[hooks.")
                .and_then(|header| header.strip_suffix("]]"))
                .filter(|event| events.contains(event) && !seen.contains(event));
            match event {
                Some(event) => {
                    seen.push(event);
                    expecting_body = true;
                    end += 1;
                    continue;
                }
                None => break,
            }
        }
        if trimmed.starts_with("hooks = [") && owned_hook_body(trimmed) {
            expecting_body = false;
            end += 1;
            continue;
        }
        break;
    }
    if seen.len() != events.len() || expecting_body {
        return config.to_string();
    }
    // The block was appended with a leading blank; it goes out with the block.
    let mut start = marker;
    while start > 0 && lines[start - 1].trim().is_empty() {
        start -= 1;
    }
    let mut out = String::with_capacity(config.len());
    for line in lines.iter().take(start).chain(lines.iter().skip(end)) {
        out.push_str(line);
    }
    out
}

// A marker comment alone does not authorize replacing commands the user edited.
// Decode our Windows wrapper before checking the installed ingress path.
fn owned_hook_body(body: &str) -> bool {
    if EVENTS.iter().any(|event| {
        [mcp_handler(event), scoped_mcp_handler(event, "external")]
            .iter()
            .any(|h| body == format!("hooks = [{h}]"))
    }) {
        return true;
    }
    let pattern = regex::Regex::new(r#"command\s*=\s*("(?:\\.|[^"\\])*")"#).unwrap();
    let commands: Vec<_> = pattern.captures_iter(body).collect();
    commands.len() == 1
        && commands.iter().all(|capture| {
            let Ok(command) = serde_json::from_str::<String>(&capture[1]) else {
                return false;
            };
            let decoded = command
                .split_once("-EncodedCommand ")
                .and_then(|(_, value)| {
                    let bytes = base64::Engine::decode(
                        &base64::engine::general_purpose::STANDARD,
                        value.trim(),
                    )
                    .ok()?;
                    if bytes.len() % 2 != 0 {
                        return None;
                    }
                    let units: Vec<u16> = bytes
                        .chunks_exact(2)
                        .map(|x| u16::from_le_bytes([x[0], x[1]]))
                        .collect();
                    String::from_utf16(&units).ok()
                });
            let text = decoded.as_deref().unwrap_or(&command).replace('\\', "/");
            text.contains("harness-plugins/codex/hook.cjs")
                || (text.starts_with("pushd . && cd /d ")
                    && text.ends_with("/harness-plugins/codex && call hook.cmd"))
        })
}

/// Rewrite the headers an earlier Que wrote as tables into the arrays Codex wants.
///
/// Only the header moves: the `hooks = [...]` line beneath it is already the body of
/// the group, so the entry keeps doing exactly what it did. Everything else in the
/// file is left byte for byte — this is the user's config, and Que is only a guest in
/// it. Matching on the newline on both sides is what keeps `[[hooks.Stop]]` (already
/// right) from being bracketed a third time.
fn repair_headers(existing: &str, events: &'static [&'static str]) -> String {
    let mut out = existing.to_string();
    for &event in events {
        for newline in ["\r\n", "\n"] {
            out = out.replace(
                &format!("{newline}[hooks.{event}]{newline}"),
                &format!("{newline}[[hooks.{event}]]{newline}"),
            );
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn npm_shim_detection_preserves_custom_launchers() {
        let tmp = tempfile::tempdir().unwrap();
        let shim = tmp.path().join("codex.cmd");
        let entry = tmp.path().join("node_modules/@openai/codex/bin/codex.js");
        std::fs::create_dir_all(entry.parent().unwrap()).unwrap();
        std::fs::write(&entry, "// entrypoint").unwrap();
        std::fs::write(&shim, "custom launcher").unwrap();
        assert!(npm_entrypoint(shim.to_str().unwrap()).is_none());
        std::fs::write(
            &shim,
            r#"node "%dp0%\node_modules\@openai\codex\bin\codex.js" %*"#,
        )
        .unwrap();
        assert_eq!(npm_entrypoint(shim.to_str().unwrap()), Some(entry));
    }

    #[test]
    fn legacy_batch_registration_remains_replaceable() {
        let command =
            "pushd . && cd /d C:/Users/John Smith/.que-dev/harness-plugins/codex && call hook.cmd";
        assert_eq!(
            strip_registration(&registration_block(command, EVENTS, 15), EVENTS),
            ""
        );
        assert!(!owned_hook_body(r#"hooks = [{command="user-hook"}]"#));
    }

    #[test]
    fn persistent_registration_is_owned_and_removable() {
        let mut block = String::from("\n# Que session state hook\n");
        for event in EVENTS {
            block.push_str(&format!(
                "[[hooks.{event}]]\nhooks = [{}]\n",
                scoped_mcp_handler(event, "external")
            ));
        }
        assert_eq!(strip_registration(&block, EVENTS), "");
        let edited = block.replacen("tool = \"session_state\"", "tool = \"user_tool\"", 1);
        assert_eq!(strip_registration(&edited, EVENTS), edited);
        let server = format!("{MCP_MARKER}\n[mcp_servers.que_session_state]\ncommand = \"node\"\nargs = [\"C:/Users/Test/harness-plugins/codex/codex-mcp.cjs\"]\n{MCP_END}");
        assert_eq!(strip_mcp_server(&server), "");
        let foreign = server.replace("harness-plugins/codex/codex-mcp.cjs", "user-server.cjs");
        assert_eq!(strip_mcp_server(&foreign), foreign);
    }

    /// Asserted per event, because one table among five arrays is enough to make Codex
    /// reject the file — and the failure then looks like a Que problem, not a typo.
    #[test]
    fn registered_events_are_arrays_of_groups() {
        let block = registration_block("/usr/bin/node \"/tmp/que/hook.cjs\"", EVENTS, 2);
        for &event in EVENTS {
            assert!(
                block.contains(&format!("[[hooks.{event}]]\n")),
                "{event} must be an array of tables"
            );
            assert!(
                !block.contains(&format!("\n[hooks.{event}]\n")),
                "{event} must not be a table"
            );
        }
    }

    /// The feature flag goes into the user's own [features] table, right after
    /// its header, instead of appending an invalid second table.
    #[test]
    fn hooks_feature_is_enabled_inside_an_existing_features_table() {
        let config = "[features]\ngoals = true\n\n[projects.'c:\\x']\ntrust_level = \"trusted\"\n";
        let fixed = enable_hooks_feature(config);
        assert!(fixed.contains("[features]\nhooks = true\ngoals = true\n"));
        assert_eq!(fixed.matches("[features]").count(), 1);
        // Already enabled: untouched. No [features] at all: untouched.
        assert_eq!(
            enable_hooks_feature("[features]\nhooks = true\n"),
            "[features]\nhooks = true\n"
        );
        assert_eq!(
            enable_hooks_feature("[model]\nname = \"gpt\"\n"),
            "[model]\nname = \"gpt\"\n"
        );
        // Subtables are not the plain table, and other tables' hooks keys don't count.
        assert_eq!(
            enable_hooks_feature("[features.other]\nx = 1\n"),
            "[features.other]\nx = 1\n"
        );
        assert_eq!(
            enable_hooks_feature("[hooks.state]\nhooks = true\n"),
            "[hooks.state]\nhooks = true\n"
        );
    }

    /// The un-install drops exactly the appended block. A user group with the
    /// same event name directly after it ends the scan and survives; an
    /// incomplete block (fewer groups than events) is left untouched entirely.
    #[test]
    fn strip_removes_only_the_que_block() {
        let head = "[features]\nhooks = true\n";
        let tail = "[mcp_servers.x]\ncommand = 'x'\n";
        let block = registration_block("node C:/x/harness-plugins/codex/hook.cjs", EVENTS, 15);
        let user_group = "[[hooks.Stop]]\nhooks = [{ type = \"command\", command = \"user own\", timeout = 9 }]\n";

        // Adjacent same-event user group: our block strips, the user's survives.
        let config = format!("{head}{block}{user_group}{tail}");
        let cleaned = strip_registration(&config, EVENTS);
        assert_eq!(cleaned, format!("{head}{user_group}{tail}"));

        // Incomplete block (groups missing): safety beats tidiness, no removal.
        let partial = format!("{head}# Que session state hook\n[[hooks.Stop]]\nhooks = []\n{tail}");
        assert_eq!(strip_registration(&partial, EVENTS), partial);
    }

    #[test]
    fn encoded_registration_is_replaceable_but_user_edits_are_preserved() {
        let command = crate::harness::windows::windows_hook_command(
            "C:/Program Files/node.exe",
            "C:/Que/harness-plugins/codex/hook.cjs",
            None,
        );
        let block = registration_block(&command, EVENTS, 15);
        assert!(block.contains("# Que session state hook"));
        assert_eq!(strip_registration(&block, EVENTS), "");
        let edited = block.replacen(
            &serde_json::to_string(&command).unwrap(),
            "\"user-custom-hook\"",
            1,
        );
        assert_eq!(strip_registration(&edited, EVENTS), edited);
        let missing_last_body = block[..block.rfind("hooks = [").unwrap()].to_string();
        assert_eq!(
            strip_registration(&missing_last_body, EVENTS),
            missing_last_body
        );
    }

    /// An install written before the shape was corrected is repaired in place, and the
    /// entries survive: only the header was ever wrong.
    #[test]
    fn table_headers_from_an_earlier_install_are_repaired() {
        let entry = "hooks = [{ type = \"command\", command = \"node\", timeout = 2 }]";
        let broken = format!("\n# Que session state hook\n[hooks.Stop]\n{entry}\n");
        let fixed = repair_headers(&broken, EVENTS);
        assert!(fixed.contains("\n[[hooks.Stop]]\n"));
        assert!(!fixed.contains("\n[hooks.Stop]\n"));
        assert!(
            fixed.contains(entry),
            "the group itself must not be touched"
        );
        // Repairing twice must not stack a third bracket, and a correct block is a no-op.
        assert_eq!(repair_headers(&fixed, EVENTS), fixed);
        let block = registration_block("node", EVENTS, 2);
        assert_eq!(repair_headers(&block, EVENTS), block);
    }

    /// Anything that is not Que's own header is left exactly as it was — including the
    /// CLI's own `[hooks.state]` tables, which live under the same key.
    #[test]
    fn a_repair_touches_nothing_else() {
        let theirs = "[model]\nname = \"gpt\"\n\n[hooks.state.\"/Users/x/.codex/hooks.json:stop:0:0\"]\ntrusted_hash = \"sha256:1\"\n";
        assert_eq!(repair_headers(theirs, EVENTS), theirs);
    }

    #[test]
    fn reads_codex_exit_footer() {
        let output = "\x1b]0;\x07Session ID: 12345678-1234-1234-1234-123456789abc\n";
        assert_eq!(
            codex_exit_session_id(output).as_deref(),
            Some("12345678-1234-1234-1234-123456789abc")
        );
    }

    #[test]
    fn index_keeps_day_without_title() {
        let (titles, days) =
            parse_index(r#"{"id":"abc","updated_at":"2026-07-30T07:55:40.566345Z"}"#);
        assert!(titles.is_empty());
        assert_eq!(days.get("abc").map(String::as_str), Some("2026-07-30"));
    }

    #[test]
    fn first_user_skips_environment() {
        let body = r#"
{"type":"session_meta"}
{"type":"response_item","payload":{"role":"user","content":[{"type":"input_text","text":"<environment_context>\ncwd"}]}}
{"type":"response_item","payload":{"role":"user","content":[{"type":"input_text","text":"嗷嗷"}]}}
"#;
        assert_eq!(first_user_from_rollout(body).as_deref(), Some("嗷嗷"));
    }
}
