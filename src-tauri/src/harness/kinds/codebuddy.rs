//! CodeBuddy: a real harness of its own — its own manifest directory, its own binary,
//! its own title tiers — that happens to share Claude's plugin layout and transcript
//! format. It used to ride in on Claude's registry default; it is spelled out here.

use super::claude::{family_plan, EVENTS};
use super::label_text::{clip, json_text, SessionLabel};
use super::registry::{resume_flag, Adapter, Ctx, GlobalCtx, Harness, Plan, UserMerge};
use super::session_find::{find_first, safe_name_id};
use super::session_label::SessionFacts;
use crate::error::AppResult;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;

pub struct CodeBuddy;

pub static CODEBUDDY: CodeBuddy = CodeBuddy;

impl Harness for CodeBuddy {
    fn hook_command(&self, host: &super::install::Host, event: Option<&str>) -> String {
        // CodeBuddy's default command-hook executor is Git Bash on Windows.
        // Forward slashes retain drive paths; POSIX quoting handles spaces and $.
        if host.windows {
            let executable = host
                .root
                .join("que-hook.exe")
                .to_string_lossy()
                .into_owned();
            return [Some(executable.as_str()), Some("codebuddy"), event]
                .into_iter()
                .flatten()
                .map(|value| crate::ssh::shell_quote(&value.replace('\\', "/")))
                .collect::<Vec<_>>()
                .join(" ");
        }
        host.generic_hook_command(event)
    }
    fn id(&self) -> &'static str {
        "codebuddy"
    }
    fn adapter(&self) -> Option<Adapter> {
        Some(Adapter::new("codebuddy", &[], resume_flag))
    }

    fn events(&self) -> &'static [&'static str] {
        EVENTS
    }

    fn plan<'a>(
        &'a self,
        ctx: Ctx<'a>,
    ) -> Pin<Box<dyn Future<Output = AppResult<Plan>> + Send + 'a>> {
        Box::pin(async move {
            if ctx.host.remote {
                return family_plan(ctx, self.events()).await;
            }
            #[cfg(windows)]
            crate::harness::windows::install_native_hook(&ctx.host.root, "que-hook")?;
            let command = self.hook_command(ctx.host, None);
            let mut plan = Plan::default();
            // One shared registration serves internal and external sessions. Do not
            // also load the same events through --plugin-dir.
            plan.files.insert(
                "codebuddy-user-hooks.json".into(),
                hook_config(&command).to_string(),
            );
            plan.user_config.push(UserMerge {
                path: codebuddy_home()
                    .join("settings.json")
                    .to_string_lossy()
                    .into_owned(),
                payload: "codebuddy-user-hooks.json",
                local: merge_local,
                remote: None,
            });
            Ok(plan)
        })
    }

    /// Register in CodeBuddy settings for ordinary external launches.
    fn global(&self, ctx: &GlobalCtx) {
        let result = (|| -> AppResult<()> {
            ctx.install_ingress("codebuddy")?;
            #[cfg(not(windows))]
            let command = [&ctx.node, &ctx.hook_path("codebuddy")]
                .into_iter()
                .map(|s| crate::ssh::shell_quote(&s.replace('\\', "/")))
                .collect::<Vec<_>>()
                .join(" ");
            #[cfg(windows)]
            let command = {
                let exe = crate::harness::windows::install_native_hook(
                    &ctx.plugins.join("codebuddy"),
                    "que-hook",
                )?;
                format!(
                    "{} codebuddy",
                    crate::ssh::shell_quote(&exe.to_string_lossy().replace('\\', "/"))
                )
            };
            let path = codebuddy_home().join("settings.json");
            let existing = std::fs::read_to_string(&path).ok();
            let merged = merge_settings(existing.as_deref(), &hook_config(&command))?;
            std::fs::create_dir_all(path.parent().unwrap())?;
            crate::paths::atomic_write(&path, &merged)?;
            Ok(())
        })();
        if let Err(error) = result {
            crate::debuglog::log_error("install external CodeBuddy hooks", &error);
        }
    }

    /// Remove only Que handlers, preserving unrelated settings.
    fn unglobal(&self, _ctx: &GlobalCtx) {
        let path = codebuddy_home().join("settings.json");
        if let Ok(existing) = std::fs::read_to_string(&path) {
            if let Ok(merged) = merge_settings(Some(&existing), &serde_json::json!({"hooks":{}})) {
                let _ = crate::paths::atomic_write(&path, &merged);
            }
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
        codebuddy_session_details(id)
    }
}

fn hook_config(command: &str) -> serde_json::Value {
    let hooks: serde_json::Map<String, serde_json::Value> = EVENTS
        .iter()
        .map(|event| {
            (
                event.to_string(),
                serde_json::json!([{"hooks":[{"type":"command","command":command,"timeout":15}]}]),
            )
        })
        .collect();
    serde_json::json!({"hooks":hooks})
}

fn merge_local(
    existing: Option<&str>,
    payload: &str,
    _host: &super::install::Host,
) -> AppResult<String> {
    merge_settings(existing, &serde_json::from_str(payload)?)
}

fn merge_settings(existing: Option<&str>, incoming: &serde_json::Value) -> AppResult<String> {
    let mut value: serde_json::Value = serde_json::from_str(existing.unwrap_or("{}"))?;
    let object = value
        .as_object_mut()
        .ok_or_else(|| crate::error::AppError::msg("Invalid CodeBuddy settings"))?;
    let hooks = object
        .entry("hooks")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or_else(|| crate::error::AppError::msg("Invalid CodeBuddy hooks"))?;
    for event in EVENTS {
        let entries = hooks
            .entry(event.to_string())
            .or_insert_with(|| serde_json::json!([]))
            .as_array_mut()
            .ok_or_else(|| crate::error::AppError::msg("Invalid CodeBuddy hook event"))?;
        entries.retain_mut(|group| {
            let Some(handlers) = group.get_mut("hooks").and_then(|v| v.as_array_mut()) else {
                return true;
            };
            let before = handlers.len();
            handlers.retain(|handler| {
                !handler
                    .get("command")
                    .and_then(|v| v.as_str())
                    .is_some_and(|c| {
                        c.replace('\\', "/")
                            .contains("/harness-plugins/codebuddy/hook.cjs")
                            || c.replace('\\', "/")
                                .contains("/harness-plugins/codebuddy/que-hook.exe")
                    })
            });
            before == handlers.len() || !handlers.is_empty()
        });
        if let Some(add) = incoming["hooks"][*event].as_array() {
            entries.extend(add.iter().cloned());
        }
    }
    Ok(serde_json::to_string_pretty(&value)?)
}

// —— the session store ——

fn codebuddy_home() -> PathBuf {
    if let Ok(path) = std::env::var("CODEBUDDY_CONFIG_DIR") {
        if !path.trim().is_empty() {
            return PathBuf::from(path);
        }
    }
    crate::paths::user_home()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".codebuddy")
}

/// Mirrors CodeBuddy's `PathUtils.getHomeProjectsDir()`: transcripts live at
/// `<home>/projects/<compressed-cwd>/<session-id>.jsonl`.
fn transcript_path(session_id: &str) -> Option<PathBuf> {
    find_first(
        &[codebuddy_home().join("projects")],
        &format!("{session_id}.jsonl"),
    )
}

fn session_exists(session_id: &str) -> bool {
    if !safe_name_id(session_id) {
        return false;
    }
    transcript_path(session_id).is_some()
}

fn session_label(session_id: &str) -> SessionLabel {
    if !safe_name_id(session_id) {
        return SessionLabel::default();
    }
    let Some(body) =
        transcript_path(session_id).and_then(|path| std::fs::read_to_string(path).ok())
    else {
        return SessionLabel::default();
    };
    SessionLabel {
        name: session_title(&body),
        first_prompt: first_user_prompt(&body),
    }
}

/// CodeBuddy keeps titles as transcript entries instead of Claude's sidecar file,
/// and resolves them in the same tiered order it uses for `getEffectiveSessionTitle`:
/// last user-set title wins, then the last usable generated title, then the derived topic.
fn session_title(body: &str) -> Option<String> {
    let mut custom = None;
    let mut generated = None;
    let mut topic = None;
    for line in body.lines() {
        let Ok(entry) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if let Some(text) = title_entry(&entry, "custom-title", "customTitle") {
            custom = Some(text);
        } else if let Some(text) = generated_title_entry(&entry, "ai-title", "aiTitle") {
            generated = Some(text);
        } else if let Some(text) = generated_title_entry(&entry, "topic", "topic") {
            topic = Some(text);
        }
    }
    custom.or(generated).or(topic)
}

/// A user-set title only has to be non-empty, matching the CLI.
fn title_entry(entry: &serde_json::Value, kind: &str, key: &str) -> Option<String> {
    if entry.get("type").and_then(|v| v.as_str()) != Some(kind) {
        return None;
    }
    entry.get(key).and_then(|v| v.as_str()).and_then(clip)
}

/// Generated titles additionally have to survive `isGeneratedPlaceholderTitle`.
fn generated_title_entry(entry: &serde_json::Value, kind: &str, key: &str) -> Option<String> {
    let text = title_entry(entry, kind, key)?;
    if is_placeholder_title(&text) {
        return None;
    }
    Some(text)
}

/// CodeBuddy treats these generated values as "no title yet".
fn is_placeholder_title(value: &str) -> bool {
    let text = value.trim();
    text.is_empty()
        || text == "(No content)"
        || text == "/compact"
        || (text.starts_with("<image_local_path>") && text.ends_with("</image_local_path>"))
}

/// First real user message, used as the card-title fallback.
///
/// CodeBuddy persists `{type:"message", role:"user", content, providerData}` where the
/// meta flags live under `providerData`; Claude-compatible `{type:"user", message}`
/// transcripts are accepted too so a mixed history still resolves.
fn first_user_prompt(body: &str) -> Option<String> {
    for line in body.lines() {
        let Ok(entry) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if !is_real_user_message(&entry) {
            continue;
        }
        if let Some(text) = entry
            .get("content")
            .and_then(json_text)
            .or_else(|| entry.get("message").and_then(json_text))
        {
            return Some(text);
        }
    }
    None
}

fn is_real_user_message(entry: &serde_json::Value) -> bool {
    let kind = entry.get("type").and_then(|v| v.as_str());
    if kind == Some("message") {
        if entry.get("role").and_then(|v| v.as_str()) != Some("user") {
            return false;
        }
        // Internal prompts injected by the CLI itself are not user intent.
        let provider = entry.get("providerData");
        let flag =
            |key: &str| provider.and_then(|v| v.get(key)).and_then(|v| v.as_bool()) == Some(true);
        if flag("isMeta") || flag("isCompactInternal") || flag("skipRun") {
            return false;
        }
        if provider
            .and_then(|v| v.get("agent"))
            .and_then(|v| v.as_str())
            == Some("compact")
        {
            return false;
        }
        // A teammate message is someone else's text, not this terminal's prompt.
        return provider
            .and_then(|v| v.get("teammateMessage"))
            .and_then(|v| v.get("from"))
            .map(|v| !v.is_string())
            .unwrap_or(true);
    }
    // Claude-compatible transcript shape, with the flag at the top level.
    kind == Some("user") && entry.get("isMeta") != Some(&serde_json::Value::Bool(true))
}

fn extract_turn_text(raw_msg: &serde_json::Value) -> String {
    match raw_msg {
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
        serde_json::Value::Array(parts) => {
            let mut joined = Vec::new();
            for part in parts {
                if let Some(t) = part.get("text").and_then(|t| t.as_str()) {
                    joined.push(t.trim().to_string());
                }
            }
            if joined.is_empty() {
                json_text(raw_msg).unwrap_or_default()
            } else {
                joined.join("\n\n")
            }
        }
        _ => json_text(raw_msg).unwrap_or_default(),
    }
}

pub(super) fn parse_codebuddy_details(body: &str, label: SessionLabel) -> SessionFacts {
    let mut turns = Vec::new();
    let mut last_user = None;
    let mut last_assistant = None;
    let mut session_cwd = None;

    for line in body.lines() {
        let Ok(entry) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if session_cwd.is_none() {
            if let Some(c) = entry.get("cwd").and_then(|v| v.as_str()) {
                session_cwd = Some(c.to_string());
            }
        }
        let kind = entry.get("type").and_then(|v| v.as_str());
        if kind == Some("message") {
            let role = entry.get("role").and_then(|v| v.as_str());
            let raw_msg = entry.get("content").or_else(|| entry.get("message"));
            let text = raw_msg.map(extract_turn_text).unwrap_or_default();
            if text.is_empty() || super::label_text::is_noise(&text) {
                continue;
            }
            if role == Some("user") {
                if !is_real_user_message(&entry) {
                    continue;
                }
                last_user = Some(text.clone());
                turns.push(crate::models::ExternalTurn {
                    role: "user".into(),
                    text,
                });
            } else if role == Some("assistant") {
                last_assistant = Some(text.clone());
                turns.push(crate::models::ExternalTurn {
                    role: "assistant".into(),
                    text,
                });
            }
        } else {
            // Claude-compatible format
            if entry.get("isMeta") == Some(&serde_json::Value::Bool(true)) {
                continue;
            }
            let Some(raw_msg) = entry.get("message") else {
                continue;
            };
            let text = extract_turn_text(raw_msg);
            if text.is_empty() || super::label_text::is_noise(&text) {
                continue;
            }
            if kind == Some("user") {
                last_user = Some(text.clone());
                turns.push(crate::models::ExternalTurn {
                    role: "user".into(),
                    text,
                });
            } else if kind == Some("assistant") {
                last_assistant = Some(text.clone());
                turns.push(crate::models::ExternalTurn {
                    role: "assistant".into(),
                    text,
                });
            }
        }
    }

    SessionFacts {
        name: label.name,
        cwd: session_cwd,
        prompt: last_user.or(label.first_prompt),
        reply: last_assistant,
        turns,
    }
}

pub(super) fn codebuddy_session_details(session_id: &str) -> Option<SessionFacts> {
    if !safe_name_id(session_id) {
        return None;
    }
    let label = session_label(session_id);
    let path = transcript_path(session_id)?;
    let body = std::fs::read_to_string(path).ok()?;
    Some(parse_codebuddy_details(&body, label))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn custom_title_wins_over_generated() {
        let body = r#"
{"type":"ai-title","aiTitle":"生成的标题"}
{"type":"topic","topic":"话题"}
{"type":"custom-title","customTitle":"我的会话"}
"#;
        assert_eq!(session_title(body).as_deref(), Some("我的会话"));
    }

    #[test]
    fn latest_entry_of_a_tier_wins() {
        let body = r#"
{"type":"custom-title","customTitle":"旧标题"}
{"type":"custom-title","customTitle":"新标题"}
"#;
        assert_eq!(session_title(body).as_deref(), Some("新标题"));
    }

    #[test]
    fn falls_back_to_topic_and_skips_placeholders() {
        let body = r#"
{"type":"ai-title","aiTitle":"   "}
{"type":"ai-title","aiTitle":"(No content)"}
{"type":"ai-title","aiTitle":"<image_local_path>/tmp/a.png</image_local_path>"}
{"type":"topic","topic":"重构队列"}
"#;
        assert_eq!(session_title(body).as_deref(), Some("重构队列"));
    }

    #[test]
    fn placeholder_topic_yields_no_title() {
        let body = r#"
{"type":"ai-title","aiTitle":"/compact"}
{"type":"topic","topic":"(No content)"}
"#;
        assert_eq!(session_title(body), None);
    }

    /// Shape captured from a real `~/.codebuddy/projects/<slug>/<id>.jsonl`.
    #[test]
    fn reads_codebuddy_message_items() {
        let body = r#"
{"id":"a1","timestamp":"2026-09-16T01:00:00.000Z","type":"message","role":"user","content":[{"type":"input_text","text":"nihao"}],"providerData":{"agent":"cli","conversationRequestId":"req1"},"__codebuddyLocal":true,"sessionId":"01a0a62a","cwd":"c:\\Users\\ZIXT"}
{"type":"file-history-snapshot","messageId":"a1","snapshot":{},"cwd":"c:\\Users\\ZIXT"}
{"type":"reasoning","content":[],"providerData":{"agent":"cli","model":"hy4-preview-f"}}
{"type":"summary","summary":"用户打了个招呼","providerData":{"source":"initial-user-message"}}
{"type":"message","role":"assistant","content":[{"type":"output_text","text":"你好！有什么可以帮你的？"}],"message":{"usage":{"input_tokens":1}}}
{"type":"turn-metrics","durationMs":1200}
"#;
        assert_eq!(first_user_prompt(body).as_deref(), Some("nihao"));
    }

    #[test]
    fn skips_internal_codebuddy_prompts() {
        let body = r#"
{"type":"message","role":"user","providerData":{"isMeta":true},"content":[{"type":"input_text","text":"caveat"}]}
{"type":"message","role":"assistant","content":"ok"}
{"type":"message","role":"user","providerData":{"isCompactInternal":true},"content":[{"type":"input_text","text":"/compact"}]}
{"type":"message","role":"user","providerData":{"agent":"compact"},"content":[{"type":"input_text","text":"压缩"}]}
{"type":"message","role":"user","providerData":{"skipRun":true},"content":[{"type":"input_text","text":"跳过"}]}
{"type":"message","role":"user","providerData":{"teammateMessage":{"from":"alice"}},"content":[{"type":"input_text","text":"别人的消息"}]}
{"type":"message","role":"user","providerData":{"agent":"cli"},"content":[{"type":"input_text","text":"修复登陆卡顿"}]}
"#;
        assert_eq!(first_user_prompt(body).as_deref(), Some("修复登陆卡顿"));
    }

    #[test]
    fn still_reads_claude_shaped_transcripts() {
        let body = r#"
{"type":"user","isMeta":true,"message":{"content":"caveat"}}
{"type":"user","message":{"role":"user","content":"<command-name>/clear</command-name>"}}
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"优化卡片标题"}]}}
"#;
        assert_eq!(first_user_prompt(body).as_deref(), Some("优化卡片标题"));
    }

    #[test]
    fn unsafe_ids_are_rejected() {
        assert!(!session_exists("../etc/passwd"));
        assert_eq!(session_label("a/b"), SessionLabel::default());
    }

    #[test]
    fn reads_codebuddy_details_with_turns_and_reply() {
        let body = r#"
{"id":"a1","timestamp":"2026-09-16T01:00:00.000Z","type":"message","role":"user","content":[{"type":"input_text","text":"实现一个红黑树"}],"sessionId":"01a0a62a","cwd":"/Users/zixt/projects/trees"}
{"type":"summary","summary":"用户打了个招呼","providerData":{"source":"initial-user-message"}}
{"type":"message","role":"assistant","content":[{"type":"output_text","text":"这是红黑树的实现代码。"}],"message":{"usage":{"input_tokens":1}}}
"#;
        let label = SessionLabel {
            name: Some("红黑树".into()),
            first_prompt: Some("实现一个红黑树".into()),
        };
        let facts = parse_codebuddy_details(body, label);
        assert_eq!(facts.name.as_deref(), Some("红黑树"));
        assert_eq!(facts.cwd.as_deref(), Some("/Users/zixt/projects/trees"));
        assert_eq!(facts.prompt.as_deref(), Some("实现一个红黑树"));
        assert_eq!(facts.reply.as_deref(), Some("这是红黑树的实现代码。"));
        assert_eq!(facts.turns.len(), 2);
        assert_eq!(facts.turns[0].role, "user");
        assert_eq!(facts.turns[0].text, "实现一个红黑树");
        assert_eq!(facts.turns[1].role, "assistant");
        assert_eq!(facts.turns[1].text, "这是红黑树的实现代码。");
    }
}
