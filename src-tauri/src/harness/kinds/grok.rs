//! Grok: a bundle of its own, copied into the CLI's hook directory, which is marked so
//! Que can tell its own file from one the user wrote.

use super::install::Host;
use super::label_text::{clip, json_text, SessionLabel};
use super::registry::{
    resume_flag, Adapter, Ctx, GlobalCtx, Harness, LaunchTweaks, Plan, UserMerge,
};
use super::session_find::{find_all, find_dir, safe_name_id};
use crate::error::{AppError, AppResult};
use crate::paths::atomic_write;
use crate::ssh::ssh_exec;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;

const EVENTS: &[&str] = &[
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "Stop",
    "StopFailure",
    "StopCancelled",
    "Notification",
];

/// Copies the bundle into place on a remote host, refusing a file Que does not own.
const SSH_COPY: &str = r#"const fs=require("node:fs"),p=require("node:path"),src=process.argv[1],dest=process.argv[2];if(fs.existsSync(dest)&&JSON.parse(fs.readFileSync(dest,"utf8")).queManaged!==true)throw Error("Existing hook file is not owned by Que");fs.mkdirSync(p.dirname(dest),{recursive:true,mode:448});fs.copyFileSync(src,dest);fs.chmodSync(dest,384);"#;

async fn plan(ctx: Ctx<'_>, events: &'static [&'static str]) -> AppResult<Plan> {
    let mut plan = Plan::default();
    let path = if ctx.workspace.kind == "ssh" {
        let host = ctx
            .workspace
            .ssh_host
            .as_deref()
            .ok_or_else(|| AppError::msg("工作区不存在"))?;
        let home = String::from_utf8_lossy(
            &ssh_exec(host, r#"printf "%s" "${GROK_HOME:-$HOME/.grok}""#).await?,
        )
        .trim()
        .to_string();
        format!("{home}/hooks/que-session-state.json")
    } else {
        std::env::var("GROK_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| home().join(".grok"))
            .join("hooks/que-session-state.json")
            .to_string_lossy()
            .into_owned()
    };
    let command = ctx.host.command(None);
    let mut hooks = serde_json::Map::new();
    for &event in events {
        hooks.insert(event.into(), serde_json::json!([{ "hooks": [{ "type":"command", "command":command, "timeout":2 }] }]));
    }
    plan.files.insert(
        "grok-hooks.json".into(),
        serde_json::json!({ "queManaged": true, "hooks": hooks }).to_string(),
    );
    plan.user_config.push(UserMerge {
        path,
        payload: "grok-hooks.json",
        local: merge_local,
        remote: Some((SSH_COPY, |_host: &Host, path: &str, payload: &str| {
            vec![payload.to_string(), path.to_string()]
        })),
    });
    Ok(plan)
}

/// Grok's file is a copy, not a merge: the whole file is Que's, guarded by the marker.
fn merge_local(existing: Option<&str>, payload: &str, _host: &Host) -> AppResult<String> {
    owned(existing)?;
    Ok(payload.to_string())
}

fn home() -> PathBuf {
    crate::paths::user_home().unwrap_or_else(|| PathBuf::from("."))
}

/// Write over the CLI's hook file only when it still carries Que's marker.
fn owned(existing: Option<&str>) -> AppResult<()> {
    match existing {
        Some(raw) => {
            let parsed: serde_json::Value = serde_json::from_str(raw)?;
            if parsed.get("queManaged") != Some(&serde_json::json!(true)) {
                return Err(AppError::machine_detail("HARNESS_HOOKS_FOREIGN", "grok"));
            }
            Ok(())
        }
        None => Ok(()),
    }
}

pub struct Grok;

pub static GROK: Grok = Grok;

pub(crate) fn native_signal(
    payload: &serde_json::Value,
    at: i64,
    external: bool,
) -> Option<super::signals::HookSignal> {
    let field = |keys: &[&str]| {
        keys.iter()
            .find_map(|key| payload.get(key).and_then(serde_json::Value::as_str))
    };
    let event = field(&["hook_event_name", "hookEventName"])?;
    let event = match event {
        "session_start" => "SessionStart",
        "user_prompt_submit" => "UserPromptSubmit",
        "pre_tool_use" => "PreToolUse",
        "post_tool_use" => "PostToolUse",
        "post_tool_use_failure" => "PostToolUseFailure",
        "stop" => "Stop",
        "stop_failure" => "StopFailure",
        "stop_cancelled" => "StopCancelled",
        "notification" => "Notification",
        other => other,
    };
    if !EVENTS.contains(&event) {
        return None;
    }
    let clean = |value: &str, max: usize| {
        value
            .chars()
            .filter(|c| !c.is_control() || *c == '\n')
            .take(max)
            .collect::<String>()
            .trim()
            .to_owned()
    };
    let session = field(&["sessionId", "session_id"])?;
    if session.is_empty() {
        return None;
    }
    Some(super::signals::HookSignal {
        kind: Some("grok".into()),
        at,
        event: event.into(),
        session_id: Some(clean(session, 256)),
        external: Some(external),
        tool: field(&["toolName", "tool_name"]).map(|v| clean(v, 256)),
        notification: field(&["notificationType", "notification_type", "type"])
            .map(|v| clean(v, 256)),
        prompt: (event == "UserPromptSubmit")
            .then(|| field(&["prompt"]).map(|v| clean(v, 4000)))
            .flatten(),
        reply_preview: (event == "Stop")
            .then(|| {
                field(&[
                    "text",
                    "last_assistant_message",
                    "lastAssistantMessage",
                    "prompt_response",
                    "response",
                    "message",
                    "content",
                ])
                .map(|v| clean(v, 2000))
            })
            .flatten(),
        workspace_root: external
            .then(|| field(&["workspaceRoot", "workspace_root", "cwd"]).map(|v| clean(v, 512)))
            .flatten(),
        ..super::signals::HookSignal::default()
    })
}

impl Harness for Grok {
    fn id(&self) -> &'static str {
        "grok"
    }
    fn adapter(&self) -> Option<Adapter> {
        Some(Adapter::new("grok", &[], resume_flag))
    }

    /// Grok's own launcher spells the flag without the dashes.
    fn version_flag(&self) -> &'static str {
        "version"
    }

    fn launch_tweaks(&self) -> LaunchTweaks {
        LaunchTweaks {
            dark_canvas: true,
            ..LaunchTweaks::default()
        }
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

    /// What a Grok session Que never launched needs: its own ingress, and the bundle
    /// copied into the CLI's hook directory under Que's `queManaged` marker.
    fn global(&self, ctx: &GlobalCtx) {
        if let Err(error) = ctx.install_ingress("grok") {
            crate::debuglog::log_error("install external Grok ingress", &error);
            return;
        }
        #[cfg(windows)]
        let command = crate::harness::windows::windows_hook_command(
            &ctx.node,
            &ctx.hook_path("grok"),
            None,
        );
        #[cfg(not(windows))]
        let command = format!(
            "{} {}",
            crate::ssh::shell_quote(&ctx.node),
            crate::ssh::shell_quote(&ctx.hook_path("grok"))
        );
        let mut hooks = serde_json::Map::new();
        for &event in self.events() {
            hooks.insert(event.into(), serde_json::json!([{ "hooks": [{"type":"command", "command":command, "timeout":2}] }]));
        }
        let dir = grok_home().join("hooks");
        let existing = std::fs::read_to_string(dir.join("que-session-state.json")).ok();
        if let Err(error) = owned(existing.as_deref()) {
            crate::debuglog::log_error("install external Grok hooks", &error);
            return;
        }
        let _ = std::fs::create_dir_all(&dir);
        let _ = atomic_write(
            &dir.join("que-session-state.json"),
            &serde_json::json!({ "queManaged": true, "hooks": hooks }).to_string(),
        );
    }

    /// The bundle file is wholly Que-owned (`queManaged`), so removal is deletion.
    fn unglobal(&self, _ctx: &GlobalCtx) {
        let file = grok_home().join("hooks/que-session-state.json");
        if let Ok(existing) = std::fs::read_to_string(&file) {
            if owned(Some(&existing)).is_ok() {
                let _ = std::fs::remove_file(file);
            }
        }
    }

    fn remote_root(&self, home: &str, _token: &str, _ingress_sha: &str) -> String {
        format!("{home}/.cache/que/harness-plugins/grok")
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
}

// —— the session store ——

fn grok_home() -> PathBuf {
    if let Ok(path) = std::env::var("GROK_HOME") {
        return PathBuf::from(path);
    }
    crate::paths::user_home()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".grok")
}

fn session_exists(session_id: &str) -> bool {
    safe_name_id(session_id) && find_dir(&[grok_home().join("sessions")], session_id).is_some()
}

fn session_label(session_id: &str) -> SessionLabel {
    if !safe_name_id(session_id) {
        return SessionLabel::default();
    }
    let dir = find_dir(&[grok_home().join("sessions")], session_id);
    let name = dir
        .as_ref()
        .and_then(|path| std::fs::read_to_string(path.join("summary.json")).ok())
        .and_then(|body| title_from_summary(&body));
    let mut first_prompt = None;
    if let Some(parent) = dir.as_ref().and_then(|path| path.parent()) {
        first_prompt = std::fs::read_to_string(parent.join("prompt_history.jsonl"))
            .ok()
            .and_then(|body| first_prompt_from_history(&body, session_id));
    }
    if first_prompt.is_none() {
        for path in find_all(&[grok_home().join("sessions")], "prompt_history.jsonl") {
            let Ok(body) = std::fs::read_to_string(&path) else {
                continue;
            };
            first_prompt = first_prompt_from_history(&body, session_id);
            if first_prompt.is_some() {
                break;
            }
        }
    }
    SessionLabel { name, first_prompt }
}

fn title_from_summary(body: &str) -> Option<String> {
    let entry = serde_json::from_str::<serde_json::Value>(body).ok()?;
    entry
        .get("generated_title")
        .and_then(|v| v.as_str())
        .and_then(clip)
}

fn first_prompt_from_history(body: &str, session_id: &str) -> Option<String> {
    for line in body.lines() {
        let Ok(entry) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if entry.get("session_id").and_then(|v| v.as_str()) != Some(session_id) {
            continue;
        }
        if let Some(text) = entry.get("prompt").and_then(|v| v.as_str()).and_then(clip) {
            return Some(text);
        }
        if let Some(text) = json_text(&entry) {
            return Some(text);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_envelope_reaches_existing_state_machine() {
        use crate::harness::signals::{observe_hook, parse_file_signal, ProbeState};
        let raw = |event: &str, extra: serde_json::Value| {
            serde_json::json!({
            "queGrokEnvelope": {
                "hookEventName":event, "sessionId":"native-test", "cwd":"C:\\John Smith\\中文",
                "prompt":extra["prompt"], "text":extra["text"], "toolName":"run_terminal_command"
            }, "at":123, "external":true
        }).to_string()
        };
        let submit = parse_file_signal(&raw(
            "user_prompt_submit",
            serde_json::json!({"prompt":"hello 中文"}),
        ))
        .unwrap();
        assert_eq!(submit.kind.as_deref(), Some("grok"));
        assert_eq!(
            submit.workspace_root.as_deref(),
            Some("C:\\John Smith\\中文")
        );
        let working = observe_hook(ProbeState::default(), submit);
        assert_eq!(working.state, "working");
        let stop =
            parse_file_signal(&raw("stop", serde_json::json!({"text":"done 中文"}))).unwrap();
        let attention = observe_hook(working, stop);
        assert_eq!(attention.state, "attention");
        assert_eq!(attention.reply_preview.as_deref(), Some("done 中文"));
        assert!(parse_file_signal(&raw("unknown", serde_json::json!({}))).is_none());
        assert!(parse_file_signal("{\"queGrokEnvelope\":{}").is_none());
    }

    #[test]
    fn first_matching_session_prompt() {
        let body = r#"
{"session_id":"a","prompt":"later"}
{"session_id":"b","prompt":"hello"}
{"session_id":"b","prompt":"second"}
"#;
        assert_eq!(
            first_prompt_from_history(body, "b").as_deref(),
            Some("hello")
        );
    }

    #[test]
    fn reads_generated_title() {
        assert_eq!(
            title_from_summary(r#"{"generated_title":"aaa","title_is_manual":true}"#).as_deref(),
            Some("aaa")
        );
        assert_eq!(title_from_summary(r#"{"generated_title":"  "}"#), None);
    }

    #[test]
    fn refuses_unowned_file() {
        let unowned = r#"{"hooks":{}}"#;
        assert!(owned(Some(unowned)).is_err());
        assert!(owned(Some(r#"{"queManaged":true}"#)).is_ok());
        assert!(owned(None).is_ok());
    }
}
