//! Pi and OMP: an in-process extension rather than a command hook, registered with
//! `--extension`. OMP is a fork with its own binary and a home-directory allowance,
//! keyed for settings under Pi's external-ingress entry.

use super::label_text::{json_text, SessionLabel};
use super::registry::{checked_id, Adapter, Ctx, GlobalCtx, Harness, Plan, VersionGate};
use super::session_find::{find_first, safe_name_id};
use crate::error::AppResult;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;

const EXTERNAL_MARKER: &str = "// Que external extension v1";
const OBSERVER_FILE: &str = "que-pi-omp-observer.mjs";
const EXTERNAL_FILE: &str = "que-pi-omp-external.ts";
const LEGACY_OBSERVER_FILE: &str = "pi-extension.mjs";
const LEGACY_EXTERNAL_FILE: &str = "que-external.ts";

fn external_entry(ctx: &GlobalCtx, kind: &str) -> PathBuf {
    let agent = if kind == "omp" {
        std::env::var("PI_CODING_AGENT_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| ctx.home.join(".omp/agent"))
    } else {
        std::env::var("PI_CODING_AGENT_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| ctx.home.join(".pi/agent"))
    };
    agent.join("extensions").join(EXTERNAL_FILE)
}

fn install_external(ctx: &GlobalCtx, kind: &str) -> AppResult<()> {
    ctx.install_plugin(kind, "harness-pi.mjs", OBSERVER_FILE)?;
    // This name was ambiguous enough to look like a Pi-owned file. A running
    // extension can keep its module open on Windows, so deletion is best-effort.
    let _ = std::fs::remove_file(ctx.plugins.join(kind).join(LEGACY_OBSERVER_FILE));
    let entry = external_entry(ctx, kind);
    if entry.exists() && !std::fs::read_to_string(&entry)?.starts_with(EXTERNAL_MARKER) {
        return Err(crate::error::AppError::msg(
            "Que external extension path belongs to another extension",
        ));
    }
    let module = url::Url::from_file_path(ctx.plugins.join(kind).join(OBSERVER_FILE))
        .map_err(|_| crate::error::AppError::msg("Invalid extension path"))?;
    let options = serde_json::json!({"kind":kind,"signalDir":crate::paths::external_signal_dir(),"enabledFile":entry});
    // Ambient copies skip Que cards, which already pass their own --extension.
    let source = format!("{EXTERNAL_MARKER}\nimport observer from {};\nexport default function(api) {{ if (process.env.QUE_HARNESS_SIGNAL_DIR || process.env.QUE_HARNESS_CHANNEL) return; return observer(api, {options}); }}\n", serde_json::to_string(module.as_str())?);
    std::fs::create_dir_all(entry.parent().unwrap())?;
    crate::paths::atomic_write(&entry, &source)?;
    remove_marked_file(&entry.with_file_name(LEGACY_EXTERNAL_FILE));
    Ok(())
}

fn remove_marked_file(path: &std::path::Path) {
    if std::fs::read_to_string(path).is_ok_and(|source| source.starts_with(EXTERNAL_MARKER)) {
        let _ = std::fs::remove_file(path);
    }
}

fn remove_external(ctx: &GlobalCtx, kind: &str) {
    let entry = external_entry(ctx, kind);
    remove_marked_file(&entry);
    remove_marked_file(&entry.with_file_name(LEGACY_EXTERNAL_FILE));
}

async fn plan(ctx: Ctx<'_>) -> AppResult<Plan> {
    let mut plan = Plan::default();
    plan.files.insert(
        OBSERVER_FILE.into(),
        std::fs::read_to_string(ctx.bin_dir.join("harness-pi.mjs"))?,
    );
    let extension = ctx.host.relative(OBSERVER_FILE);
    plan.args.extend(["--extension".into(), extension]);
    Ok(plan)
}

fn resume_args(session_id: &str) -> AppResult<Vec<String>> {
    Ok(vec!["--session".into(), checked_id(session_id)?.into()])
}

/// The agent_settled event the state integration relies on needs this floor; a CLI
/// under it would start a card that never leaves "starting".
fn version_at_least_0_80_4(version: &str) -> bool {
    let re = regex::Regex::new(r"(?:^|\s)v?(\d+)\.(\d+)\.(\d+)").unwrap();
    let Some(caps) = re.captures(version) else {
        return false;
    };
    let major: u32 = caps[1].parse().unwrap_or(0);
    let minor: u32 = caps[2].parse().unwrap_or(0);
    let patch: u32 = caps[3].parse().unwrap_or(0);
    major > 0 || minor > 80 || (minor == 80 && patch >= 4)
}

pub struct Pi;

pub static PI: Pi = Pi;

impl Harness for Pi {
    fn id(&self) -> &'static str {
        "pi"
    }
    fn adapter(&self) -> Option<Adapter> {
        Some(Adapter::new("pi", &[], resume_args))
    }

    /// The only synchronous version floor: the gate runs on the connect path because a
    /// card under it could never report state at all.
    fn version_gate(&self) -> Option<VersionGate> {
        Some(VersionGate::new("0.80.4", version_at_least_0_80_4))
    }

    fn plan<'a>(
        &'a self,
        ctx: Ctx<'a>,
    ) -> Pin<Box<dyn Future<Output = AppResult<Plan>> + Send + 'a>> {
        Box::pin(plan(ctx))
    }

    /// Pi is loaded by an extension, so that is all a session Que never launched needs.
    fn global(&self, ctx: &GlobalCtx) {
        for kind in ["pi", "omp"] {
            if let Err(error) = install_external(ctx, kind) {
                crate::debuglog::log_error("install external Pi/OMP extension", &error);
            }
        }
    }
    /// Remove the extension copy `global` laid down; the next card launch rewrites it.
    fn unglobal(&self, ctx: &GlobalCtx) {
        for kind in ["pi", "omp"] {
            remove_external(ctx, kind);
        }
    }

    fn external_ingress(&self) -> bool {
        true
    }

    // —— the session store ——

    fn session_exists(&self, id: &str) -> Option<bool> {
        Some(session_exists(&pi_sessions(), id))
    }
    fn session_label(&self, id: &str, _need_first_prompt: bool) -> Option<SessionLabel> {
        Some(session_label(&pi_sessions(), id))
    }
}

pub struct Omp;

pub static OMP: Omp = Omp;

impl Harness for Omp {
    fn guesses_attention(&self, signal: &super::signals::HookSignal) -> bool {
        signal.event == "PreToolUse" && signal.tool.as_deref() == Some("ask")
    }
    fn id(&self) -> &'static str {
        "omp"
    }
    /// OMP sessions report through Pi's extension, so the settings toggle is shared.
    fn ingress_key(&self) -> &'static str {
        "pi"
    }
    fn adapter(&self) -> Option<Adapter> {
        Some(Adapter::new("omp", &["--allow-home"], resume_args))
    }

    fn plan<'a>(
        &'a self,
        ctx: Ctx<'a>,
    ) -> Pin<Box<dyn Future<Output = AppResult<Plan>> + Send + 'a>> {
        Box::pin(plan(ctx))
    }

    // —— the session store ——

    fn session_exists(&self, id: &str) -> Option<bool> {
        Some(session_exists(&omp_sessions(), id))
    }
    fn session_label(&self, id: &str, _need_first_prompt: bool) -> Option<SessionLabel> {
        Some(session_label(&omp_sessions(), id))
    }
}

// —— the session store ——

fn pi_sessions() -> PathBuf {
    if let Ok(path) = std::env::var("PI_HOME") {
        return PathBuf::from(path).join("agent").join("sessions");
    }
    crate::paths::user_home()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".pi")
        .join("agent")
        .join("sessions")
}

fn omp_sessions() -> PathBuf {
    if let Ok(path) = std::env::var("PI_CODING_AGENT_DIR") {
        return PathBuf::from(path).join("sessions");
    }
    crate::paths::user_home()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".omp")
        .join("agent")
        .join("sessions")
}

fn name_from_jsonl(body: &str) -> Option<String> {
    let mut name = None;
    for line in body.lines() {
        let Ok(entry) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let kind = entry.get("type").and_then(|v| v.as_str());
        name = match kind {
            Some("session_info") => entry
                .get("name")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string()),
            Some("title") => entry
                .get("title")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string()),
            _ => continue,
        };
    }
    name
}

fn session_exists(sessions: &PathBuf, session_id: &str) -> bool {
    safe_name_id(session_id)
        && find_first(&[sessions.clone()], &format!("*_{session_id}.jsonl")).is_some()
}

fn session_label(sessions: &PathBuf, session_id: &str) -> SessionLabel {
    if !safe_name_id(session_id) {
        return SessionLabel::default();
    }
    let Some(body) = find_first(&[sessions.clone()], &format!("*_{session_id}.jsonl"))
        .and_then(|path| std::fs::read_to_string(path).ok())
    else {
        return SessionLabel::default();
    };
    SessionLabel {
        name: name_from_jsonl(&body),
        first_prompt: first_user_prompt(&body),
    }
}

fn first_user_prompt(body: &str) -> Option<String> {
    for line in body.lines() {
        let Ok(entry) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if entry.get("type").and_then(|v| v.as_str()) != Some("message") {
            continue;
        }
        let Some(message) = entry.get("message") else {
            continue;
        };
        if message.get("role").and_then(|v| v.as_str()) != Some("user") {
            continue;
        }
        if let Some(text) = json_text(message) {
            return Some(text);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn latest_session_info_wins() {
        let body = r#"
{"type":"session","id":"s1"}
{"type":"session_info","name":"first"}
{"type":"message"}
{"type":"session_info","name":"renamed"}
"#;
        assert_eq!(name_from_jsonl(body).as_deref(), Some("renamed"));
    }

    #[test]
    fn empty_name_clears() {
        let body = r#"
{"type":"session_info","name":"keep"}
{"type":"session_info","name":"  "}
"#;
        assert_eq!(name_from_jsonl(body), None);
    }

    #[test]
    fn title_record_is_name() {
        let body = r#"
{"type":"session_info","name":"  "}
{"type":"title","title":"Hello There"}
"#;
        assert_eq!(name_from_jsonl(body).as_deref(), Some("Hello There"));
    }

    #[test]
    fn first_user_message() {
        let body = r#"
{"type":"session"}
{"type":"message","message":{"role":"user","content":"nihao"}}
{"type":"message","message":{"role":"assistant","content":"ok"}}
"#;
        assert_eq!(first_user_prompt(body).as_deref(), Some("nihao"));
    }
}
