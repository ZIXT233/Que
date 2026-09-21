//! Cursor Agent.
//!
//! Cursor answers its own permission hooks, so this ingress must return the JSON verdict
//! the CLI waits for, and its kind is baked into every command so a foreign IDE session
//! — which inherits neither the channel nor the signal dir — still answers correctly.
//!
//! Its user-level `hooks.json` is shared with hooks the user wrote, so Que merges into it
//! and only ever replaces entries it can prove are its own.

use super::debug::{HarnessDebugEvent, ProbeView};
use super::install::Host;
use super::label_text::{clip, SessionLabel};
use super::registry::{
    resume_flag, Adapter, Ctx, GlobalCtx, Harness, LaunchTweaks, Plan, UserMerge,
};
use super::session_find::{find_all, find_dir, safe_name_id};
use super::session_label::{clean_text, SessionFacts, TURN_MAX_CHARS};
use super::signals::HookSignal;
use crate::error::{AppError, AppResult};
use crate::paths::atomic_write;
use crate::terminal::PtyProbe;
use regex::Regex;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::OnceLock;

const EVENTS: &[&str] = &[
    "sessionStart",
    "beforeSubmitPrompt",
    "preToolUse",
    "postToolUse",
    "postToolUseFailure",
    "beforeShellExecution",
    "beforeMCPExecution",
    "afterAgentResponse",
    "stop",
    "sessionEnd",
];

/// Merges Que's entries into `~/.cursor/hooks.json` on a remote host, keeping foreign
/// ones. Mirrors `merge_user_hooks`.
const SSH_MERGE: &str = r#"const fs=require("node:fs"),p=require("node:path"),dest=process.argv[1],src=process.argv[2],hook=process.argv[3];const owned=c=>{if(typeof c!=="string")return false;if(c.includes(hook))return true;const m=c.match(/-EncodedCommand\s+(\S+)/);if(m){try{const s=Buffer.from(m[1],"base64").toString("utf16le");if(s.includes(hook)||/[\\/](?:harness-plugins[\\/]cursor|\.cache[\\/]que[\\/]harness)[\\/].*hook\.cjs/.test(s))return true;}catch{}}return /[\\/](?:harness-plugins[\\/]cursor|\.cache[\\/]que[\\/]harness)[\\/].*hook\.cjs/.test(c)};const incoming=JSON.parse(fs.readFileSync(src,"utf8"));let x=fs.existsSync(dest)?JSON.parse(fs.readFileSync(dest,"utf8")):{};if(!x||Array.isArray(x)||typeof x!=="object")throw Error("Invalid Cursor hooks configuration");const hooks={...(x.hooks&&typeof x.hooks==="object"&&!Array.isArray(x.hooks)?x.hooks:{})};for(const [event,entries] of Object.entries(incoming.hooks||{})){const cur=Array.isArray(hooks[event])?hooks[event]:[];hooks[event]=[...cur.filter(e=>!owned(e&&e.command)),...entries];}x={...x,version:1,hooks};fs.mkdirSync(p.dirname(dest),{recursive:true,mode:448});fs.writeFileSync(dest+".que.tmp",JSON.stringify(x,null,2),{mode:384});fs.renameSync(dest+".que.tmp",dest);"#;

async fn plan(ctx: Ctx<'_>, events: &'static [&'static str]) -> AppResult<Plan> {
    let mut plan = Plan::default();
    plan.files.insert(
        ".cursor-plugin/plugin.json".into(),
        serde_json::json!({ "name": "que-session-state", "version": "1.0.0", "description": "Report this Que terminal's lifecycle" }).to_string(),
    );
    let mut hooks = serde_json::Map::new();
    for event in events {
        hooks.insert(
            event.to_string(),
            serde_json::json!([command_entry(
                ctx.host.command(Some(event)),
                ctx.host.timeout
            )]),
        );
    }
    // The plugin's own manifest is inert: the hooks that run come from the user-level
    // file below, which is also where a foreign Cursor session finds them.
    plan.files.insert(
        "hooks/hooks.json".into(),
        serde_json::json!({ "version": 1, "hooks": {} }).to_string(),
    );
    plan.files.insert(
        "cursor-user-hooks.json".into(),
        serde_json::json!({ "version": 1, "hooks": hooks }).to_string(),
    );
    // No --plugin-dir: the plugin manifest is empty and all lifecycle hooks
    // are registered in the user config below. Loading it only adds CLI work.
    let path = if ctx.workspace.kind == "local" {
        user_hooks_path().to_string_lossy().into_owned()
    } else {
        // The remote sink has no card directory to report into, so its signals land under
        // this token's cards folder instead.
        plan.files
            .insert(format!("cards/{}/.keep", ctx.host.token), String::new());
        format!(
            "{}/.cursor/hooks.json",
            ctx.host.home.as_deref().unwrap_or_default()
        )
    };
    plan.user_config.push(UserMerge {
        path,
        payload: "cursor-user-hooks.json",
        local: merge_local,
        remote: Some((SSH_MERGE, |host: &Host, path: &str, payload: &str| {
            vec![
                path.to_string(),
                payload.to_string(),
                host.hook_path.clone(),
            ]
        })),
    });
    Ok(plan)
}

/// Local install of the shared `hooks.json`: merge Que's entries in, keep foreign ones.
fn merge_local(existing: Option<&str>, payload: &str, host: &Host) -> AppResult<String> {
    let existing: serde_json::Value = match existing {
        Some(raw) => serde_json::from_str(raw)?,
        None => serde_json::json!({}),
    };
    let merged = merge_user_hooks(existing, &serde_json::from_str(payload)?, &host.hook_path)?;
    serde_json::to_string_pretty(&merged).map_err(Into::into)
}

pub struct Cursor;

fn command_entry(command: String, timeout: u32) -> serde_json::Value {
    // Cursor reads command/timeout. Grok's compatibility reader instead expects
    // a Claude matcher group here: an empty hooks list makes our entry an inert
    // group for that reader, without disabling any user compatibility settings.
    serde_json::json!({ "command": command, "timeout": timeout, "hooks": [] })
}

pub static CURSOR: Cursor = Cursor;

impl Harness for Cursor {
    fn id(&self) -> &'static str {
        "cursor"
    }
    fn adapter(&self) -> Option<Adapter> {
        Some(Adapter::new("cursor-agent", &[], resume_flag))
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

    /// What a Cursor session Que never launched needs: its own ingress, plus entries in
    /// the user-level `hooks.json` that IDE chats and plain terminals read from anywhere.
    fn global(&self, ctx: &GlobalCtx) {
        let _ = ctx.install_ingress("cursor");
        let hook_path = ctx.hook_path("cursor");
        let mut hooks = serde_json::Map::new();
        for &event in self.events() {
            #[cfg(windows)]
            let cmd = crate::harness::windows::windows_hook_command(&ctx.node, &hook_path, Some(event));
            #[cfg(not(windows))]
            let cmd = format!(
                "QUE_HARNESS_KIND=cursor {} {} {}",
                crate::ssh::shell_quote(&ctx.node),
                crate::ssh::shell_quote(&hook_path),
                event
            );
            hooks.insert(
                event.to_string(),
                serde_json::json!([command_entry(cmd, 15)]),
            );
        }
        let path = user_hooks_path();
        let existing = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_else(|| serde_json::json!({}));
        if let Ok(merged) = merge_user_hooks(
            existing,
            &serde_json::json!({ "version": 1, "hooks": hooks }),
            &hook_path,
        ) {
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let _ = atomic_write(
                &path,
                &serde_json::to_string_pretty(&merged).unwrap_or_default(),
            );
        }
    }

    /// Remove the entries `global` merged in — the inverse of `merge_user_hooks`.
    /// Foreign entries stay; events left empty drop out with them.
    fn unglobal(&self, ctx: &GlobalCtx) {
        let hook_path = ctx.hook_path("cursor");
        let path = user_hooks_path();
        let Ok(existing) = std::fs::read_to_string(&path) else {
            return;
        };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&existing) else {
            return;
        };
        let Ok(cleaned) = unmerge_user_hooks(value, &hook_path) else {
            return;
        };
        if cleaned != existing {
            let _ = atomic_write(
                &path,
                &serde_json::to_string_pretty(&cleaned).unwrap_or_default(),
            );
        }
    }

    fn launch_tweaks(&self) -> LaunchTweaks {
        LaunchTweaks {
            kitty_notifications: true,
            windows_direct_launch: true,
            ssh_unset: &["GHOSTTY_RESOURCES_DIR"],
            ..LaunchTweaks::default()
        }
    }

    /// Cursor still runs command hooks through its own shell executor on Windows;
    /// allow for that startup cost even though Que avoids a nested helper normally.
    fn hook_timeout(&self, windows_local: bool) -> u32 {
        if windows_local {
            15
        } else {
            2
        }
    }

    /// Avoid adding another interpreter to Cursor's own hook shell executor.
    fn hook_command(&self, host: &Host, event: Option<&str>) -> String {
        host.generic_hook_command_with_prefix(event, "QUE_HARNESS_KIND=cursor ")
    }

    /// The remote sink has no card directory to report into, so its signals land under
    /// this token's cards folder instead.
    fn remote_signal_dir(&self, host: &Host) -> Option<String> {
        Some(format!("{}/cards/{}", host.root.display(), host.token))
    }

    /// A tool start whose gate Cursor answers itself (the ingress returns `allow`): the
    /// payload never says whether the user was asked, so every tool call is a guess.
    fn guesses_attention(&self, signal: &HookSignal) -> bool {
        ["preToolUse", "beforeShellExecution", "beforeMCPExecution"]
            .contains(&signal.event.as_str())
    }

    fn external_ingress(&self) -> bool {
        true
    }

    // —— the session store ——

    fn session_exists(&self, id: &str) -> Option<bool> {
        Some(session_exists(id))
    }
    fn session_label(&self, id: &str, _need_first_prompt: bool) -> Option<SessionLabel> {
        Some(session_label(id))
    }
    /// Cursor's store is the conversation itself: the last user turn is what this session is
    /// answering, and the last assistant turn is the reply a notice shows.
    fn session_details(&self, id: &str) -> Option<SessionFacts> {
        let file = session_file(id)?;
        let last = |role: Role| {
            file.turns
                .iter()
                .rev()
                .find(|turn| turn.role == role)
                .map(|turn| turn.text.clone())
        };
        Some(SessionFacts {
            name: file.title,
            cwd: file.cwd,
            // The store is this session's own record, so it wins; the CLI's input history is
            // shared with whatever conversation was resumed before it.
            prompt: last(Role::User).or(file.last_prompt),
            reply: last(Role::Assistant),
            turns: file.turns.iter().map(external_turn).collect(),
        })
    }

    // —— debug ——

    fn debug_clues(
        &self,
        probe: Option<&ProbeView>,
        pty: Option<&PtyProbe>,
        events: &[HarnessDebugEvent],
        out: &mut Vec<String>,
    ) {
        let Some(probe) = probe else { return };
        let looks_cursor = !probe.notify_osc_seen.is_empty()
            || events.iter().any(|e| {
                e.source == "notify-osc"
                    || matches!(
                        e.event.as_str(),
                        "sessionStart" | "beforeSubmitPrompt" | "afterAgentResponse" | "preToolUse"
                    )
            });
        if looks_cursor
            && probe.notify_osc_seen.is_empty()
            && !events.iter().any(|e| e.source == "notify-osc")
        {
            if pty.is_some_and(|pty| pty.last_focus.as_deref() == Some("focused")) {
                out.push("流里没见到 OSC 99/9/777，且已向 PTY 写过 CSI I（前台）：Cursor 默认不发桌面通知".into());
            } else {
                out.push(
                    "流里没见到 OSC 99/9/777：要么 Cursor 没发，要么探针 panic 把那一段吞了".into(),
                );
            }
        } else if looks_cursor
            && !events
                .iter()
                .any(|e| e.source == "notify-osc" && e.event == "Notification")
        {
            out.push(format!(
                "流里见到了 {}，但没拼出完整通知（分片未结束或探针崩了）",
                probe.notify_osc_seen.join("/")
            ));
        }
    }
}

// —— the Windows `.cmd` shim shortcut ——

/// A `.cmd` shim whose bootstrap only wraps cmd → powershell → node (the
/// official Cursor CLI installer layout). Launching node on the script
/// directly keeps the same target minus two interpreter startups, which cost
/// seconds per launch on Windows.
pub struct DirectNodeLaunch {
    pub node: String,
    pub script: String,
    /// Applied by the caller only for keys the session env does not carry yet,
    /// matching the bootstrap's own "if unset" guards.
    pub env: Vec<(String, String)>,
}

pub(crate) fn direct_node_launch(shim: &str) -> Option<DirectNodeLaunch> {
    if !shim.to_ascii_lowercase().ends_with(".cmd") {
        return None;
    }
    let dir = Path::new(shim).parent()?.to_path_buf();
    let (node, script) = if dir.join("node.exe").is_file() && dir.join("index.js").is_file() {
        (dir.join("node.exe"), dir.join("index.js"))
    } else {
        let version = latest_cursor_version(&dir)?;
        let script = version.join("index.js");
        if !script.is_file() {
            return None;
        }
        // Each installed version carries its own node.exe; the bootstrap never
        // consults PATH. Fall back to PATH node only if an update was interrupted.
        let bundled = version.join("node.exe");
        let node = if bundled.is_file() {
            bundled
        } else {
            which::which("node").ok()?.into()
        };
        (node, script)
    };
    let mut env = vec![(
        "CURSOR_INVOKED_AS".into(),
        shim.rsplit(['\\', '/']).next().unwrap_or(shim).to_string(),
    )];
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        env.push((
            "NODE_COMPILE_CACHE".into(),
            PathBuf::from(local)
                .join("cursor-compile-cache")
                .to_string_lossy()
                .into_owned(),
        ));
    }
    Some(DirectNodeLaunch {
        node: node.to_string_lossy().into_owned(),
        script: script.to_string_lossy().into_owned(),
        env,
    })
}

/// Newest `versions\<date>-<hash>` directory, same YYYYMMDD integer the
/// official bootstrap sorts by. Build timestamps inside the name break ties.
fn latest_cursor_version(dir: &Path) -> Option<PathBuf> {
    let re = Regex::new(r"^\d{4}\.\d{1,2}\.\d{1,2}(-\d{2}-\d{2}-\d{2})?-[a-f0-9]+$").unwrap();
    let mut best: Option<(i64, String, PathBuf)> = None;
    for entry in std::fs::read_dir(dir.join("versions")).ok()?.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if !re.is_match(name) {
            continue;
        }
        let Some(stamp) = version_stamp(name) else {
            continue;
        };
        if best
            .as_ref()
            .is_none_or(|b| (stamp, name.to_string()) > (b.0, b.1.clone()))
        {
            best = Some((stamp, name.to_string(), path));
        }
    }
    best.map(|(_, _, path)| path)
}

fn version_stamp(name: &str) -> Option<i64> {
    let mut parts = name.split('-').next()?.split('.');
    let year: i64 = parts.next()?.parse().ok()?;
    let month: i64 = parts.next()?.parse().ok()?;
    let day: i64 = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some(year * 10_000 + month * 100 + day)
}

// —— the session store ——

/// Bound the walk: keeps conversation history up to 1000 turns.
const TAIL_TURNS: usize = 1_000;
/// Memory guard for one message: allow large code blocks and detailed responses.
const MAX_TURN_CHARS: usize = 64_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    User,
    Assistant,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Role::User => "user",
            Role::Assistant => "assistant",
        }
    }
}

/// One message of the session's record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Turn {
    pub role: Role,
    pub text: String,
}

/// What Cursor's session record says.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CursorSession {
    pub title: Option<String>,
    pub cwd: Option<String>,
    /// Most recent prompt in the CLI's own input history or transcript.
    pub last_prompt: Option<String>,
    /// The conversation itself, oldest first, straight from the session's live transcript.
    pub turns: Vec<Turn>,
}

fn title_from_meta(body: &str) -> Option<String> {
    meta_text(body, "title").and_then(|s| clip(&s))
}

fn meta_text(body: &str, key: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()?
        .get(key)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

fn cursor_chats() -> PathBuf {
    crate::paths::user_home()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".cursor")
        .join("chats")
}

fn cursor_projects() -> PathBuf {
    crate::paths::user_home()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".cursor")
        .join("projects")
}

/// Locate the session's live JSONL transcript in `~/.cursor/projects/*/agent-transcripts/<id>/<id>.jsonl`.
fn find_transcript_file(session_id: &str) -> Option<PathBuf> {
    if !safe_name_id(session_id) {
        return None;
    }
    let target = format!("{session_id}.jsonl");
    let roots = [cursor_projects(), cursor_chats()];
    let mut files = find_all(&roots, &target);
    // The session might exist under multiple project folders; pick the most recently modified one.
    files.sort_by(|a, b| {
        let time_a = std::fs::metadata(a).and_then(|m| m.modified()).ok();
        let time_b = std::fs::metadata(b).and_then(|m| m.modified()).ok();
        time_b.cmp(&time_a)
    });
    files.into_iter().next()
}

fn session_exists(session_id: &str) -> bool {
    safe_name_id(session_id)
        && (find_transcript_file(session_id).is_some()
            || find_dir(&[cursor_chats()], session_id).is_some())
}

fn session_label(session_id: &str) -> SessionLabel {
    let dir = session_dir(session_id);
    let name = dir
        .as_deref()
        .and_then(read_meta)
        .and_then(|b| title_from_meta(&b));
    let first_prompt = find_transcript_file(session_id)
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|body| first_user_prompt(&body))
        .or_else(|| {
            dir.as_deref()
                .and_then(|d| read_file(&d.join("prompt_history.json")))
                .and_then(|b| first_prompt_from_history(&b))
        });
    SessionLabel { name, first_prompt }
}

/// The session's live record: title, workspace directory and full conversation history.
fn session_file(session_id: &str) -> Option<CursorSession> {
    let transcript_path = find_transcript_file(session_id);
    let dir = session_dir(session_id);
    if transcript_path.is_none() && dir.is_none() {
        return None;
    }

    let meta = dir.as_deref().and_then(read_meta);
    let turns = transcript_path
        .and_then(|path| std::fs::read_to_string(path).ok())
        .map(|body| parse_transcript(&body))
        .unwrap_or_default();

    let last_prompt_fallback = dir
        .as_deref()
        .and_then(|d| read_file(&d.join("prompt_history.json")))
        .and_then(|b| newest_prompt_from_history(&b));

    Some(CursorSession {
        title: meta.as_deref().and_then(title_from_meta),
        cwd: meta.as_deref().and_then(|b| meta_text(b, "cwd")),
        last_prompt: last_prompt_fallback,
        turns,
    })
}

fn session_dir(session_id: &str) -> Option<PathBuf> {
    safe_name_id(session_id)
        .then(|| find_dir(&[cursor_chats()], session_id))
        .flatten()
}

fn read_meta(dir: &Path) -> Option<String> {
    read_file(&dir.join("meta.json"))
}

fn read_file(path: &Path) -> Option<String> {
    std::fs::read_to_string(path).ok()
}

/// In Cursor's `prompt_history.json`, items are prepend-ordered (index 0 is newest).
fn newest_prompt_from_history(body: &str) -> Option<String> {
    let rows = serde_json::from_str::<Vec<serde_json::Value>>(body).ok()?;
    rows.first().and_then(|row| {
        row.as_str()
            .and_then(clip)
            .or_else(|| super::label_text::json_text(row))
    })
}

/// The earliest prompt in history (last element in prepend-ordered array).
fn first_prompt_from_history(body: &str) -> Option<String> {
    let rows = serde_json::from_str::<Vec<serde_json::Value>>(body).ok()?;
    rows.last().and_then(|row| {
        row.as_str()
            .and_then(clip)
            .or_else(|| super::label_text::json_text(row))
    })
}

/// Parses a Cursor agent-transcript JSONL stream into an ordered list of turns.
fn parse_transcript(body: &str) -> Vec<Turn> {
    let mut turns: Vec<Turn> = Vec::new();
    for line in body.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let role = match value.get("role").and_then(|v| v.as_str()) {
            Some("assistant") => Role::Assistant,
            Some("user") => Role::User,
            _ => continue,
        };
        let raw_text = match value
            .get("message")
            .and_then(|m| m.get("content"))
            .or_else(|| value.get("content"))
        {
            Some(serde_json::Value::String(s)) => s.clone(),
            Some(serde_json::Value::Array(arr)) => {
                let parts: Vec<&str> = arr
                    .iter()
                    .filter(|item| item.get("type").and_then(|t| t.as_str()) == Some("text"))
                    .filter_map(|item| item.get("text").and_then(|t| t.as_str()))
                    .collect();
                parts.join("\n")
            }
            _ => continue,
        };
        let text = match role {
            Role::Assistant => clean_turn(&raw_text),
            Role::User => match extract_user_query(&raw_text) {
                Some(ask) => ask,
                None => continue,
            },
        };
        if text.is_empty() {
            continue;
        }
        // Merge consecutive assistant fragments so interim tool uses don't shatter the reply.
        if role == Role::Assistant {
            if let Some(last) = turns.last_mut().filter(|t| t.role == Role::Assistant) {
                if !last.text.is_empty() {
                    last.text.push_str("\n\n");
                }
                last.text.push_str(&text);
                if last.text.len() > MAX_TURN_CHARS {
                    last.text.truncate(MAX_TURN_CHARS);
                }
                continue;
            }
        }
        turns.push(Turn { role, text });
    }
    if turns.len() > TAIL_TURNS {
        turns.drain(..turns.len() - TAIL_TURNS);
    }
    turns
}

/// Extract the true user prompt, stripping away injected system/environment context.
fn extract_user_query(raw: &str) -> Option<String> {
    if let Some(ask) = between(raw, "<user_query>", "</user_query>") {
        let ask = clean_turn(ask);
        return (!ask.is_empty()).then_some(ask);
    }
    let text = clean_turn(raw);
    (!text.is_empty() && !text.starts_with('<')).then_some(text)
}

fn first_user_prompt(body: &str) -> Option<String> {
    for line in body.lines() {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line.trim()) else {
            continue;
        };
        if value.get("role").and_then(|v| v.as_str()) != Some("user") {
            continue;
        }
        let raw_text = match value
            .get("message")
            .and_then(|m| m.get("content"))
            .or_else(|| value.get("content"))
        {
            Some(serde_json::Value::String(s)) => s.clone(),
            Some(serde_json::Value::Array(arr)) => arr
                .iter()
                .filter(|item| item.get("type").and_then(|t| t.as_str()) == Some("text"))
                .filter_map(|item| item.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join("\n"),
            _ => continue,
        };
        if let Some(ask) = extract_user_query(&raw_text) {
            return Some(ask);
        }
    }
    None
}

fn between<'a>(text: &'a str, open: &str, close: &str) -> Option<&'a str> {
    let rest = text.get(text.find(open)? + open.len()..)?;
    Some(rest.get(..rest.find(close)?)?)
}

fn clean_turn(text: &str) -> String {
    text.chars()
        .filter(|c| *c == '\n' || !c.is_control())
        .take(MAX_TURN_CHARS)
        .collect::<String>()
        .trim()
        .to_string()
}

fn external_turn(turn: &Turn) -> crate::models::ExternalTurn {
    crate::models::ExternalTurn {
        role: turn.role.as_str().to_string(),
        text: clean_text(&turn.text, TURN_MAX_CHARS).unwrap_or_default(),
    }
}

pub(crate) fn user_hooks_path() -> PathBuf {
    if let Ok(path) = std::env::var("QUE_CURSOR_HOOKS") {
        return PathBuf::from(path);
    }
    crate::paths::user_home()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".cursor/hooks.json")
}

fn hook_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(
            r#"[\\/](?:harness-plugins[\\/]cursor|\.cache[\\/]que[\\/]harness)[\\/].*hook\.cjs"#,
        )
        .unwrap()
    })
}

/// A command is Que's when it names this hook, or when it carries a PowerShell
/// `-EncodedCommand` that does.
fn is_owned_command(command: &str, hook_path: &str) -> bool {
    if Regex::new(r#"[\\/]harness-plugins[\\/]cursor[\\/]que-cursor-hook\.exe(?:['"\s]|$)"#)
        .unwrap()
        .is_match(command)
    {
        return true;
    }
    let pattern = hook_pattern();
    if command.contains(hook_path) || pattern.is_match(command) {
        return true;
    }
    let Some(encoded) = command
        .split_once("-EncodedCommand")
        .and_then(|(_, rest)| rest.split_whitespace().next())
    else {
        return false;
    };
    let Ok(bytes) = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, encoded)
    else {
        return false;
    };
    if bytes.len() % 2 != 0 {
        return false;
    }
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
        .collect();
    let script = String::from_utf16_lossy(&units);
    script.contains(hook_path) || pattern.is_match(&script)
}

/// Drop every group whose command belongs to Que's hook; events left empty come
/// out with them — the inverse of `merge_user_hooks`.
fn unmerge_user_hooks(
    mut value: serde_json::Value,
    hook_path: &str,
) -> AppResult<serde_json::Value> {
    let hooks = value
        .get_mut("hooks")
        .and_then(|v| v.as_object_mut())
        .ok_or_else(|| AppError::machine_detail("HARNESS_HOOKS_INVALID", "cursor"))?;
    for (_, entries) in hooks.iter_mut() {
        if let Some(list) = entries.as_array_mut() {
            list.retain(|entry| {
                !is_owned_command(
                    entry.get("command").and_then(|c| c.as_str()).unwrap_or(""),
                    hook_path,
                )
            });
        }
    }
    if let Some(hooks) = value.get_mut("hooks").and_then(|v| v.as_object_mut()) {
        hooks.retain(|_, entries| entries.as_array().is_some_and(|list| !list.is_empty()));
    }
    Ok(value)
}

/// Keep every foreign entry, drop Que's old ones, append the new ones.
fn merge_user_hooks(
    existing: serde_json::Value,
    incoming: &serde_json::Value,
    hook_path: &str,
) -> AppResult<serde_json::Value> {
    if !existing.is_null() && (existing.is_array() || !existing.is_object()) {
        return Err(AppError::machine_detail("HARNESS_HOOKS_INVALID", "cursor"));
    }
    let mut current = existing.as_object().cloned().unwrap_or_default();
    let mut hooks = current
        .get("hooks")
        .filter(|v| v.is_object() && !v.is_array())
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    if let Some(incoming_hooks) = incoming.get("hooks").and_then(|v| v.as_object()) {
        for (event, entries) in incoming_hooks {
            let previous = hooks
                .get(event)
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            let kept: Vec<serde_json::Value> = previous
                .into_iter()
                .filter(|entry| {
                    !is_owned_command(
                        entry.get("command").and_then(|c| c.as_str()).unwrap_or(""),
                        hook_path,
                    )
                })
                .collect();
            let extra = entries.as_array().cloned().unwrap_or_default();
            hooks.insert(
                event.clone(),
                serde_json::Value::Array(kept.into_iter().chain(extra).collect()),
            );
        }
    }
    current.insert("version".into(), serde_json::json!(1));
    current.insert("hooks".into(), serde_json::Value::Object(hooks));
    Ok(serde_json::Value::Object(current))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_keeps_foreign_and_replaces_owned() {
        let hook = "/home/u/.cache/que/harness/newtoken/hook.cjs";
        let existing = serde_json::json!({
            "version": 1,
            "hooks": {
                "beforeSubmitPrompt": [
                    { "command": "echo foreign" },
                    { "command": "/home/u/.cache/que/harness/oldtoken/hook.cjs" }
                ]
            }
        });
        let incoming = serde_json::json!({
            "hooks": {
                "beforeSubmitPrompt": [{ "command": format!("QUE_HARNESS_KIND=cursor /usr/bin/node {hook} beforeSubmitPrompt") }]
            }
        });
        let merged = merge_user_hooks(existing, &incoming, hook).unwrap();
        let commands: Vec<_> = merged["hooks"]["beforeSubmitPrompt"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["command"].as_str().unwrap())
            .collect();
        assert_eq!(commands, vec![
            "echo foreign",
            "QUE_HARNESS_KIND=cursor /usr/bin/node /home/u/.cache/que/harness/newtoken/hook.cjs beforeSubmitPrompt",
        ]);
    }

    #[test]
    fn merge_rejects_array_config() {
        let err = merge_user_hooks(
            serde_json::json!([]),
            &serde_json::json!({ "hooks": {} }),
            "/tmp/hook.cjs",
        )
        .unwrap_err();
        assert_eq!(err.to_string(), "HARNESS_HOOKS_INVALID");
    }

    #[test]
    fn meta_carries_title_and_workspace() {
        let body =
            r#"{"schemaVersion":1,"title":"Test File Session","cwd":"/Users/u/Projects/que"}"#;
        assert_eq!(title_from_meta(body).as_deref(), Some("Test File Session"));
        assert_eq!(
            meta_text(body, "cwd").as_deref(),
            Some("/Users/u/Projects/que")
        );
        assert_eq!(meta_text(r#"{"title":"  "}"#, "title"), None);
    }

    #[test]
    fn prompt_history_prepend_order() {
        let body = r#"["最新一条","/resume","你好"]"#;
        assert_eq!(
            newest_prompt_from_history(body).as_deref(),
            Some("最新一条")
        );
        assert_eq!(first_prompt_from_history(body).as_deref(), Some("你好"));
        assert_eq!(newest_prompt_from_history("not json"), None);
    }

    #[test]
    fn parses_realtime_transcript_stream() {
        let stream = r#"
{"role":"user","message":{"content":[{"type":"text","text":"<timestamp>Tue 9:49 PM</timestamp>\n<user_query>\npretooluse是人看之前还是看之后\n</user_query>"}]}}
{"role":"assistant","message":{"content":[{"type":"text","text":"人看之前。PreToolUse 是工具真正执行前的闸门。"}]}}
{"role":"user","message":{"content":[{"type":"text","text":"<environment_context>\nsystem stuff\n</environment_context>"}]}}
{"role":"user","message":{"content":[{"type":"text","text":"测试消息"}]}}
{"role":"assistant","message":{"content":[{"type":"tool_use","name":"Grep","input":{}},{"type":"text","text":"收到。这边正常。"}]}}
{"type":"turn_ended","status":"success"}
"#;
        let turns = parse_transcript(stream);
        assert_eq!(turns.len(), 4);
        assert_eq!(
            turns[0],
            Turn {
                role: Role::User,
                text: "pretooluse是人看之前还是看之后".into()
            }
        );
        assert_eq!(
            turns[1],
            Turn {
                role: Role::Assistant,
                text: "人看之前。PreToolUse 是工具真正执行前的闸门。".into()
            }
        );
        // environment_context was ignored
        assert_eq!(
            turns[2],
            Turn {
                role: Role::User,
                text: "测试消息".into()
            }
        );
        assert_eq!(
            turns[3],
            Turn {
                role: Role::Assistant,
                text: "收到。这边正常。".into()
            }
        );
    }

    #[test]
    fn merges_consecutive_assistant_fragments() {
        let stream = r#"
{"role":"user","message":{"content":[{"type":"text","text":"commitpush"}]}}
{"role":"assistant","message":{"content":[{"type":"text","text":"正在提交本轮改动并推到远程。"}]}}
{"role":"assistant","message":{"content":[{"type":"tool_use","name":"Shell","input":{}}]}}
{"role":"assistant","message":{"content":[{"type":"text","text":"已推到 origin/main：b540732。"}]}}
"#;
        let turns = parse_transcript(stream);
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0].role, Role::User);
        assert_eq!(turns[1].role, Role::Assistant);
        assert_eq!(
            turns[1].text,
            "正在提交本轮改动并推到远程。\n\n已推到 origin/main：b540732。"
        );
    }

    #[test]
    fn extracts_first_prompt() {
        let stream = r#"
{"role":"user","message":{"content":[{"type":"text","text":"<environment_context>noise</environment_context>"}]}}
{"role":"user","message":{"content":[{"type":"text","text":"<user_query>\n第一句真正的问题\n</user_query>"}]}}
{"role":"assistant","message":{"content":[{"type":"text","text":"答案"}]}}
"#;
        assert_eq!(
            first_user_prompt(stream).as_deref(),
            Some("第一句真正的问题")
        );
    }

    #[test]
    fn unsafe_ids_have_no_session_dir() {
        assert_eq!(session_dir("../etc"), None);
        assert_eq!(session_file("a/b"), None);
    }

    #[test]
    fn direct_launch_resolves_newest_cursor_version() {
        let _orig = std::env::var_os("LOCALAPPDATA");
        unsafe {
            std::env::set_var("LOCALAPPDATA", r"C:\Users\tester\AppData\Local");
        }
        let root = std::env::temp_dir().join(format!("que-cursor-{}", std::process::id()));
        let versions = root.join("versions");
        std::fs::create_dir_all(versions.join("2026.08.01-aaaa1111")).unwrap();
        std::fs::create_dir_all(versions.join("2026.09.10-bbbb2222")).unwrap();
        std::fs::create_dir_all(versions.join("not-a-version")).unwrap();
        std::fs::write(versions.join("2026.09.10-bbbb2222").join("node.exe"), "").unwrap();
        std::fs::write(versions.join("2026.09.10-bbbb2222").join("index.js"), "").unwrap();
        std::fs::write(versions.join("2026.08.01-aaaa1111").join("index.js"), "").unwrap();
        let shim = root.join("cursor-agent.cmd");
        std::fs::write(&shim, "").unwrap();
        let direct = direct_node_launch(shim.to_str().unwrap()).expect("direct launch");
        assert!(direct.node.contains("2026.09.10-bbbb2222") && direct.node.ends_with("node.exe"));
        assert!(
            direct.script.contains("2026.09.10-bbbb2222") && direct.script.ends_with("index.js")
        );
        assert_eq!(
            direct
                .env
                .iter()
                .find(|(k, _)| k == "CURSOR_INVOKED_AS")
                .map(|(_, v)| v.as_str()),
            Some("cursor-agent.cmd")
        );
        assert!(direct.env.iter().any(|(k, _)| k == "NODE_COMPILE_CACHE"));
        let _ = std::fs::remove_dir_all(root);
        match _orig {
            Some(val) => unsafe {
                std::env::set_var("LOCALAPPDATA", val);
            },
            None => unsafe {
                std::env::remove_var("LOCALAPPDATA");
            },
        }
    }

    #[test]
    fn direct_launch_skips_non_shims_and_broken_layouts() {
        assert!(direct_node_launch(r"C:\tools\opencode.exe").is_none());
        let root = std::env::temp_dir().join(format!("que-cursor-empty-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let shim = root.join("cursor-agent.cmd");
        std::fs::write(&shim, "").unwrap();
        assert!(
            direct_node_launch(shim.to_str().unwrap()).is_none(),
            "no versions dir yet"
        );
        let version = root.join("versions").join("2026.09.10-bbbb2222");
        std::fs::create_dir_all(&version).unwrap();
        assert!(
            direct_node_launch(shim.to_str().unwrap()).is_none(),
            "version dir without index.js"
        );
        let _ = std::fs::remove_dir_all(root);
    }
}
