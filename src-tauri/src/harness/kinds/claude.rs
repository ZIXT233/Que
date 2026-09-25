//! Claude Code and CodeBuddy: the same plugin layout, a different manifest directory,
//! a different binary — and each its own session store.

use super::registry::{resume_flag, Adapter, Ctx, GlobalCtx, Harness, Plan};
use crate::error::AppResult;
use crate::paths::atomic_write;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;

use super::label_text::{clip, json_text, SessionLabel};
use super::session_find::{find_dir, find_first, safe_name_id};
use super::session_label::SessionFacts;

/// Notification is what a blocked prompt actually reaches us through: permission
/// prompts and ask-style tools never surface as a tool call, so without it a card waits
/// forever with no signal to react to.
pub(super) const EVENTS: &[&str] = &[
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PermissionRequest",
    "Notification",
    "PostToolUse",
    "PostToolUseFailure",
    "Stop",
    "StopFailure",
];

/// CodeBuddy keeps the Claude plugin layout but resolves its own manifest directory
/// first; `hooks/hooks.json` is read the same way.
fn manifest_dir(kind: &str) -> &'static str {
    if kind == "codebuddy" {
        ".codebuddy-plugin"
    } else {
        ".claude-plugin"
    }
}

/// The install plan both family members share, apart from the manifest directory.
pub(super) async fn family_plan(ctx: Ctx<'_>, events: &'static [&'static str]) -> AppResult<Plan> {
    let mut plan = Plan::default();
    plan.files.insert(
        format!("{}/plugin.json", manifest_dir(ctx.kind)),
        serde_json::json!({ "name": "que-session-state", "version": "1.0.0", "description": "Report this Que terminal's lifecycle" }).to_string(),
    );
    let command = ctx.host.command(None);
    let mut hooks = serde_json::Map::new();
    for &event in events {
        // Claude's exec form passes paths as argv, with no Bash/PowerShell wrapper.
        // CodeBuddy has its own schema: keep its existing command form.
        let hook = if ctx.kind == "claude" {
            serde_json::json!({ "type": "command", "command": ctx.host.node, "args": [ctx.host.hook_path], "timeout": ctx.host.timeout })
        } else {
            serde_json::json!({ "type": "command", "command": command, "timeout": ctx.host.timeout })
        };
        hooks.insert(event.to_string(), serde_json::json!([{ "hooks": [hook] }]));
    }
    plan.files.insert(
        "hooks/hooks.json".into(),
        serde_json::json!({ "hooks": hooks }).to_string(),
    );
    plan.args.extend([
        "--plugin-dir".into(),
        ctx.host.root.to_string_lossy().into_owned(),
    ]);
    Ok(plan)
}

// —— the harness ——

// Match parsed command/argv strings, not serialized JSON (which doubles Windows
// backslashes). Remove only our hook, preserving other hooks in a shared group.
fn remove_owned_hooks(entries: &mut Vec<serde_json::Value>, ctx: &GlobalCtx) -> bool {
    let root = ctx
        .plugins
        .join("claude")
        .to_string_lossy()
        .replace('\\', "/");
    let mut changed = false;
    entries.retain_mut(|group| {
        let Some(hooks) = group.get_mut("hooks").and_then(|v| v.as_array_mut()) else {
            return true;
        };
        let before = hooks.len();
        hooks.retain(|hook| {
            let owned = |text: &str| {
                let text = text.replace('\\', "/");
                ["hook.cjs", "external-hook.exe", "external-hook.sh"]
                    .iter()
                    .any(|name| text.contains(&format!("{root}/{name}")))
            };
            !hook
                .get("command")
                .and_then(|v| v.as_str())
                .is_some_and(owned)
                && !hook
                    .get("args")
                    .and_then(|v| v.as_array())
                    .is_some_and(|args| args.iter().filter_map(|v| v.as_str()).any(owned))
        });
        changed |= hooks.len() != before;
        !hooks.is_empty() || before == 0
    });
    changed
}

/// The ambient registration is a full hook entry. On Unix a `.sh` shim doubles
/// as the Que-env guard for compatibility readers; on Windows the exec form
/// passes the same guard as the `--que-ambient` ingress flag.
fn install_external_launcher(ctx: &GlobalCtx) -> AppResult<serde_json::Value> {
    ctx.install_ingress("claude")?;
    let timeout = super::registry::default_hook_timeout(cfg!(windows));
    #[cfg(windows)]
    {
        Ok(serde_json::json!({
            "type": "command",
            "command": ctx.node,
            "args": [ctx.hook_path("claude"), "--que-ambient"],
            "timeout": timeout,
        }))
    }
    #[cfg(not(windows))]
    {
        use std::os::unix::fs::PermissionsExt;
        let dir = ctx.plugins.join("claude");
        let file = dir.join("external-hook.sh");
        let script = format!("#!/bin/sh\n[ -n \"${{GROK_HOOK_EVENT:-}}${{CURSOR_VERSION:-}}${{QUE_HARNESS_SIGNAL_DIR:-}}${{QUE_HARNESS_CHANNEL:-}}\" ] && exit 0\nexec {} {}\n", crate::ssh::shell_quote(&ctx.node), crate::ssh::shell_quote(&ctx.hook_path("claude")));
        atomic_write(&file, &script)?;
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o700))?;
        Ok(serde_json::json!({
            "type": "command",
            "command": file.to_string_lossy(),
            "args": [],
            "timeout": timeout,
        }))
    }
}

pub struct Claude;

pub static CLAUDE: Claude = Claude;

impl Harness for Claude {
    fn id(&self) -> &'static str {
        "claude"
    }
    fn adapter(&self) -> Option<Adapter> {
        Some(Adapter::new("claude", &[], resume_flag))
    }

    fn events(&self) -> &'static [&'static str] {
        EVENTS
    }

    fn plan<'a>(
        &'a self,
        ctx: Ctx<'a>,
    ) -> Pin<Box<dyn Future<Output = AppResult<Plan>> + Send + 'a>> {
        Box::pin(family_plan(ctx, self.events()))
    }

    /// What a Claude session Que never launched needs: its own ingress, and Que's
    /// entries merged into `~/.claude/settings.json`.
    fn global(&self, ctx: &GlobalCtx) {
        let launcher = match install_external_launcher(ctx) {
            Ok(entry) => entry,
            Err(error) => {
                crate::debuglog::log_error("install Claude external launcher", &error);
                return;
            }
        };
        let dir = ctx.home.join(".claude");
        // The VS Code extension keeps this file too, so a machine that never ran the CLI
        // still gets managed when its settings directory exists.
        let has_extension = [
            ".vscode/extensions",
            ".vscode-insiders/extensions",
            ".cursor/extensions",
        ]
        .iter()
        .any(|ext| {
            ctx.home
                .join(ext)
                .read_dir()
                .ok()
                .map(|entries| {
                    entries.filter_map(|entry| entry.ok()).any(|entry| {
                        entry
                            .file_name()
                            .to_string_lossy()
                            .starts_with("anthropic.claude-code")
                    })
                })
                .unwrap_or(false)
        });
        if !dir.exists() && !has_extension {
            return;
        }
        let _ = std::fs::create_dir_all(&dir);
        let settings = dir.join("settings.json");
        let mut value: serde_json::Value = std::fs::read_to_string(&settings)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_else(|| serde_json::json!({}));
        if let Some(obj) = value.as_object_mut() {
            let mut hooks = obj
                .get("hooks")
                .and_then(|h| h.as_object())
                .cloned()
                .unwrap_or_default();
            for &event in self.events() {
                // Keep whatever the user wrote there; replace only Que's own entries.
                let mut entries: Vec<serde_json::Value> = hooks
                    .get(event)
                    .and_then(|v| v.as_array())
                    .cloned()
                    .unwrap_or_default();
                remove_owned_hooks(&mut entries, ctx);
                entries.push(serde_json::json!({ "hooks": [launcher] }));
                hooks.insert(event.into(), serde_json::Value::Array(entries));
            }
            obj.insert("hooks".into(), serde_json::Value::Object(hooks));
            let _ = atomic_write(
                &settings,
                &serde_json::to_string_pretty(&serde_json::Value::Object(obj.clone()))
                    .unwrap_or_default(),
            );
        }
    }

    /// Remove the entries `global` merged in — Que's groups drop out of every
    /// event list (empty lists go with them), user-written hooks stay.
    fn unglobal(&self, ctx: &GlobalCtx) {
        let settings = ctx.home.join(".claude").join("settings.json");
        let Ok(existing) = std::fs::read_to_string(&settings) else {
            return;
        };
        let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&existing) else {
            return;
        };
        let mut changed = false;
        if let Some(obj) = value.as_object_mut() {
            if let Some(hooks) = obj.get_mut("hooks").and_then(|h| h.as_object_mut()) {
                for &event in self.events() {
                    if let Some(entries) = hooks.get_mut(event).and_then(|v| v.as_array_mut()) {
                        changed |= remove_owned_hooks(entries, ctx);
                        if entries.is_empty() {
                            hooks.remove(event);
                        }
                    }
                }
            }
        }
        if changed {
            let _ = atomic_write(
                &settings,
                &serde_json::to_string_pretty(&value).unwrap_or_default(),
            );
        }
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
    fn session_details(&self, id: &str) -> Option<SessionFacts> {
        claude_session_details(id).map(|details| SessionFacts {
            name: details.title,
            cwd: details.cwd,
            prompt: details.prompt,
            reply: details.reply,
            turns: details.turns,
        })
    }
}

// —— the session store ——

fn claude_home() -> PathBuf {
    claude_home_in(None)
}

fn claude_home_in(env: Option<&std::collections::HashMap<String, String>>) -> PathBuf {
    if let Some(path) = env.and_then(|env| env.get("CLAUDE_CONFIG_DIR")) {
        return PathBuf::from(path);
    }
    if let Ok(path) = std::env::var("CLAUDE_CONFIG_DIR") {
        return PathBuf::from(path);
    }
    crate::paths::user_home()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".claude")
}

fn name_from_sidecar(body: &str) -> Option<String> {
    let entry = serde_json::from_str::<serde_json::Value>(body).ok()?;
    entry
        .get("customTitle")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

pub(super) fn session_exists(session_id: &str) -> bool {
    session_exists_in(session_id, None)
}

pub(crate) fn session_exists_in(
    session_id: &str,
    env: Option<&std::collections::HashMap<String, String>>,
) -> bool {
    if !safe_name_id(session_id) {
        return false;
    }
    let projects = claude_home_in(env).join("projects");
    find_first(&[projects.clone()], &format!("{session_id}.jsonl")).is_some()
        || find_dir(&[projects], session_id).is_some()
}

pub(super) fn session_label(session_id: &str) -> SessionLabel {
    session_label_in(session_id, None)
}

pub(crate) fn session_label_in(
    session_id: &str,
    env: Option<&std::collections::HashMap<String, String>>,
) -> SessionLabel {
    if !safe_name_id(session_id) {
        return SessionLabel::default();
    }
    let projects = claude_home_in(env).join("projects");
    let name = find_dir(&[projects.clone()], session_id)
        .and_then(|dir| std::fs::read_to_string(dir.join("custom-title.json")).ok())
        .and_then(|body| name_from_sidecar(&body))
        .and_then(|s| clip(&s));
    let first_prompt = find_first(&[projects], &format!("{session_id}.jsonl"))
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|body| first_user_prompt(&body));
    SessionLabel { name, first_prompt }
}

fn first_user_prompt(body: &str) -> Option<String> {
    for line in body.lines() {
        let Ok(entry) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if entry.get("type").and_then(|v| v.as_str()) != Some("user")
            || entry.get("isMeta") == Some(&serde_json::Value::Bool(true))
        {
            continue;
        }
        if let Some(text) = entry.get("message").and_then(json_text) {
            return Some(text);
        }
    }
    None
}

#[derive(Debug, Clone, Default)]
pub struct ClaudeSessionDetails {
    pub title: Option<String>,
    pub cwd: Option<String>,
    pub prompt: Option<String>,
    pub reply: Option<String>,
    pub turns: Vec<crate::models::ExternalTurn>,
}

/// CodeBuddy keeps Claude's transcript format, so both family members read one store.
pub(super) fn claude_session_details(session_id: &str) -> Option<ClaudeSessionDetails> {
    if !safe_name_id(session_id) {
        return None;
    }
    let projects = claude_home().join("projects");
    let label = session_label(session_id);
    let path = find_first(&[projects], &format!("{session_id}.jsonl"))?;
    let body = std::fs::read_to_string(path).ok()?;
    let mut turns = Vec::new();
    let mut last_user = None;
    let mut last_assistant = None;

    for line in body.lines() {
        let Ok(entry) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let msg_type = entry.get("type").and_then(|v| v.as_str());
        if entry.get("isMeta") == Some(&serde_json::Value::Bool(true)) {
            continue;
        }
        let Some(raw_msg) = entry.get("message") else {
            continue;
        };
        let text = match raw_msg {
            serde_json::Value::String(s) => s.trim().to_string(),
            serde_json::Value::Object(o) => {
                if let Some(s) = o.get("content").and_then(|c| c.as_str()) {
                    s.trim().to_string()
                } else if let Some(parts) = o.get("content").and_then(|c| c.as_array()) {
                    let mut joined = Vec::new();
                    for part in parts {
                        if let Some(t) = part.get("text").and_then(|t| t.as_str()) {
                            joined.push(t.trim().to_string());
                        }
                    }
                    joined.join("\n\n")
                } else {
                    json_text(raw_msg).unwrap_or_default()
                }
            }
            _ => json_text(raw_msg).unwrap_or_default(),
        };
        if text.is_empty() || super::label_text::is_noise(&text) {
            continue;
        }
        if msg_type == Some("user") {
            last_user = Some(text.clone());
            turns.push(crate::models::ExternalTurn {
                role: "user".into(),
                text,
            });
        } else if msg_type == Some("assistant") {
            last_assistant = Some(text.clone());
            turns.push(crate::models::ExternalTurn {
                role: "assistant".into(),
                text,
            });
        }
    }

    Some(ClaudeSessionDetails {
        title: label.name,
        cwd: None,
        prompt: last_user.or(label.first_prompt),
        reply: last_assistant,
        turns,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_custom_title() {
        assert_eq!(
            name_from_sidecar(r#"{"customTitle":"abc"}"#).as_deref(),
            Some("abc")
        );
    }

    #[test]
    fn empty_title_is_none() {
        assert_eq!(name_from_sidecar(r#"{"customTitle":"  "}"#), None);
    }

    #[test]
    fn skips_meta_and_slash_commands() {
        let body = r#"
{"type":"user","isMeta":true,"message":{"content":"caveat"}}
{"type":"user","message":{"role":"user","content":"<command-name>/clear</command-name>"}}
{"type":"user","message":{"role":"user","content":"可口可乐"}}
"#;
        assert_eq!(first_user_prompt(body).as_deref(), Some("可口可乐"));
    }
}
