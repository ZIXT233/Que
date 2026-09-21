//! Devin CLI: Claude's hook vocabulary on a different config surface. There is no
//! plugin directory to hand a session, but `--config` swaps the user-level config
//! file — a per-card copy under the plugin root carries the hooks with the user's
//! own settings merged in, while ambient coverage goes through the real user config.

use super::registry::{default_hook_timeout, resume_flag, Adapter, Ctx, GlobalCtx, Harness, Plan};
use super::signals::HookSignal;
use crate::error::AppResult;
use crate::paths::atomic_write;
use serde_json::{Map, Value};
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;

/// Devin's lifecycle events, verbatim: the shared vocabulary reads them with no
/// per-harness translation. `PostCompaction` maps to nothing and stays for the trace.
const EVENTS: &[&str] = &[
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PermissionRequest",
    "PostToolUse",
    "Stop",
    "SessionEnd",
    "PostCompaction",
];

/// The user-level config file Devin reads: `$XDG_CONFIG_HOME/devin/config.json`,
/// or `%APPDATA%\devin\config.json` on Windows.
fn config_file() -> PathBuf {
    #[cfg(windows)]
    if let Some(appdata) = std::env::var_os("APPDATA") {
        return PathBuf::from(appdata).join("devin").join("config.json");
    }
    let root = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| crate::paths::user_home().unwrap_or_default().join(".config"));
    root.join("devin").join("config.json")
}

/// Remote hosts are POSIX: Devin reads `$XDG_CONFIG_HOME/devin/config.json`, falling
/// back to `$HOME/.config/devin/config.json`. An absent file reads as `{}`.
const READ_REMOTE_CONFIG: &str = r#"const fs=require("node:fs"),p=require("node:path");const root=process.env.XDG_CONFIG_HOME||p.join(process.env.HOME||"/",".config");try{process.stdout.write(fs.readFileSync(p.join(root,"devin","config.json"),"utf8"));}catch(e){if(e.code!=="ENOENT")throw e;process.stdout.write("{}");}"#;

/// The user config the launched session should see: the CLI's own settings plus Que's
/// hooks. A file Devin itself cannot parse is not worth failing a card over — the
/// merged copy starts empty and carries only the hooks.
async fn user_config(ctx: &Ctx<'_>) -> AppResult<Map<String, Value>> {
    let text = if ctx.workspace.kind == "ssh" {
        let host = ctx.host.host_name()?;
        String::from_utf8_lossy(
            &crate::ssh::ssh_exec(
                host,
                &[
                    crate::ssh::shell_quote(&ctx.host.node),
                    "-e".into(),
                    crate::ssh::shell_quote(READ_REMOTE_CONFIG),
                ]
                .join(" "),
            )
            .await?,
        )
        .into_owned()
    } else {
        match std::fs::read_to_string(config_file()) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => "{}".into(),
            Err(error) => return Err(error.into()),
        }
    };
    Ok(serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default())
}

/// Que's entry appended to an event's list, keeping whatever the user wrote there.
fn merge_hooks(config: &mut Map<String, Value>, command: &str, timeout: u32) {
    let mut hooks = config
        .get("hooks")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    for &event in EVENTS {
        let mut entries = hooks
            .get(event)
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        entries.push(serde_json::json!({ "hooks": [{ "type": "command", "command": command, "timeout": timeout }] }));
        hooks.insert(event.into(), Value::Array(entries));
    }
    config.insert("hooks".into(), Value::Object(hooks));
}

/// An entry Que installed is recognized by where its command points — every ambient
/// and per-card spelling lands inside `harness-plugins/devin`.
fn is_que_command(command: &str) -> bool {
    command.replace('\\', "/").contains("harness-plugins/devin")
}

/// Drop Que's groups from an event list, keeping user-written entries. Mirror of
/// Claude's ownership rule; the config file may be shared with the user's own hooks.
fn remove_owned_hooks(entries: &mut Vec<Value>) -> bool {
    let mut changed = false;
    entries.retain_mut(|group| {
        let Some(hooks) = group.get_mut("hooks").and_then(|v| v.as_array_mut()) else {
            return true;
        };
        let before = hooks.len();
        hooks.retain(|hook| {
            !hook
                .get("command")
                .and_then(|v| v.as_str())
                .is_some_and(is_que_command)
        });
        changed |= hooks.len() != before;
        !hooks.is_empty() || before == 0
    });
    changed
}

/// Splice Que's entries into (or out of) a Devin `config.json` text, preserving the
/// rest of the file. `command` is `None` when removing.
fn merge_config(existing: Option<&str>, command: Option<(&str, u32)>) -> String {
    let mut config = serde_json::from_str::<Value>(existing.unwrap_or("{}"))
        .ok()
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    let mut hooks = config
        .get("hooks")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    for &event in EVENTS {
        let mut entries = hooks
            .get(event)
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        remove_owned_hooks(&mut entries);
        if let Some((command, timeout)) = command {
            entries.push(serde_json::json!({ "hooks": [{ "type": "command", "command": command, "timeout": timeout }] }));
        }
        if entries.is_empty() {
            hooks.remove(event);
        } else {
            hooks.insert(event.into(), Value::Array(entries));
        }
    }
    if hooks.is_empty() {
        config.remove("hooks");
    } else {
        config.insert("hooks".into(), Value::Object(hooks));
    }
    serde_json::to_string_pretty(&Value::Object(config)).unwrap_or_else(|_| "{}".into())
}

pub struct Devin;

pub static DEVIN: Devin = Devin;

impl Harness for Devin {
    fn id(&self) -> &'static str {
        "devin"
    }

    fn adapter(&self) -> Option<Adapter> {
        Some(Adapter::new("devin", &[], resume_flag))
    }

    fn events(&self) -> &'static [&'static str] {
        EVENTS
    }

    /// The Windsurf Devin extension bundles the CLI inside the app; it is the only
    /// install that never lands on PATH. Absolute entries pass `home.join` through
    /// unchanged.
    fn extra_search_dirs(&self) -> &'static [&'static str] {
        &["/Applications/Devin.app/Contents/Resources/app/extensions/windsurf/devin/bin"]
    }

    fn plan<'a>(
        &'a self,
        ctx: Ctx<'a>,
    ) -> Pin<Box<dyn Future<Output = AppResult<Plan>> + Send + 'a>> {
        Box::pin(async move {
            let command = ctx.host.command(None);
            // Local Windows: the native ingress skips a PowerShell + node boot per
            // event. `que-hook.exe devin` reads the event from the payload itself.
            #[cfg(windows)]
            let command = if !ctx.host.remote {
                let exe =
                    crate::harness::windows::install_native_hook(&ctx.host.root, "que-hook")?;
                format!("{} devin", ctx.host.quote(&exe.to_string_lossy()))
            } else {
                command
            };
            let mut config = user_config(&ctx).await?;
            merge_hooks(&mut config, &command, ctx.host.timeout);
            let mut plan = Plan::default();
            plan.files.insert(
                "devin-config.json".into(),
                Value::Object(config).to_string(),
            );
            // `--config` replaces the user config file for this session only, so the
            // merged copy carries both the user's settings and Que's hooks — ambient
            // sessions without the flag never see them.
            plan.args.extend([
                "--config".into(),
                ctx.host.relative("devin-config.json"),
            ]);
            Ok(plan)
        })
    }

    /// A permission prompt Devin reports itself — but it may also fire where the
    /// configured mode auto-approves, so a quiet one is only a guess, held for the
    /// window rather than raised.
    fn guesses_attention(&self, signal: &HookSignal) -> bool {
        signal.event == "PermissionRequest"
    }

    /// Sessions Que never launched: Que's entries live in `~/.config/devin/config.json`
    /// behind an ambient launcher that skips card sessions — their `--config` file
    /// already reports them through the card sink.
    fn global(&self, ctx: &GlobalCtx) {
        let result = (|| -> AppResult<()> {
            ctx.install_ingress("devin")?;
            #[cfg(not(windows))]
            let command = {
                use std::os::unix::fs::PermissionsExt;
                let file = ctx.plugins.join("devin").join("external-hook.sh");
                let script = format!(
                    "#!/bin/sh\n[ -n \"${{QUE_HARNESS_SIGNAL_DIR:-}}${{QUE_HARNESS_CHANNEL:-}}\" ] && exit 0\nexec {} {}\n",
                    crate::ssh::shell_quote(&ctx.node),
                    crate::ssh::shell_quote(&ctx.hook_path("devin"))
                );
                atomic_write(&file, &script)?;
                std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o700))?;
                file.to_string_lossy().into_owned()
            };
            #[cfg(windows)]
            let command = {
                // The `devin-hook` stem names the kind and marks the invocation
                // ambient, so the native runtime skips sessions carrying Que env.
                let exe = crate::harness::windows::install_native_hook(
                    &ctx.plugins.join("devin"),
                    "devin-hook",
                )?;
                format!("\"{}\"", exe.to_string_lossy().replace('\\', "/"))
            };
            let path = config_file();
            let existing = std::fs::read_to_string(&path).ok();
            let merged = merge_config(
                existing.as_deref(),
                Some((&command, default_hook_timeout(cfg!(windows)))),
            );
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            atomic_write(&path, &merged)?;
            Ok(())
        })();
        if let Err(error) = result {
            crate::debuglog::log_error("install external Devin hooks", &error);
        }
    }

    /// Strip the entries `global` merged in; user-written hooks stay. Skip the write
    /// entirely when nothing of ours is there — the file keeps its own formatting.
    fn unglobal(&self, _ctx: &GlobalCtx) {
        let path = config_file();
        let Ok(existing) = std::fs::read_to_string(&path) else {
            return;
        };
        if !is_que_command(&existing) {
            return;
        }
        let _ = atomic_write(&path, &merge_config(Some(&existing), None));
    }

    fn external_ingress(&self) -> bool {
        true
    }
}
