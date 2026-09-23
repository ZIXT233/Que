//! Explicit, machine-owned startup configuration. Never writes global rc files.
use crate::{
    error::{AppError, AppResult},
    models::{CardQueue, QueueWorkspace},
    ssh::shell_quote,
};
use std::collections::HashMap;

pub fn machine_key(workspace: &QueueWorkspace) -> String {
    if workspace.kind == "ssh" {
        format!("ssh:{}", workspace.ssh_host.as_deref().unwrap_or_default())
    } else {
        "local".into()
    }
}

pub fn effective_workspace(queue: &CardQueue, workspace: &QueueWorkspace) -> QueueWorkspace {
    let mut effective = workspace.clone();
    let settings = queue.machine_settings.get(&machine_key(workspace));
    effective.terminal_rc = settings.and_then(|settings| settings.terminal_rc.clone());
    effective.session_env = settings.map(|settings| settings.session_env.clone()).unwrap_or_default();
    effective
}

/// Explicit, machine-owned overrides for Que-launched sessions. The launcher
/// adds these to its inherited environment; it never clears other variables.
pub fn validate_session_env(value: &serde_json::Value) -> AppResult<HashMap<String, String>> {
    let object = value.as_object().ok_or_else(|| AppError::msg("Session environment must be an object"))?;
    if object.len() > 64 {
        return Err(AppError::msg("Too many session environment variables"));
    }
    let mut result = HashMap::new();
    let mut size = 0;
    for (key, value) in object {
        let valid = !key.is_empty() && key.len() <= 128
            && key.as_bytes()[0].is_ascii_alphabetic()
            && key.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_');
        let value = value.as_str().ok_or_else(|| AppError::msg("Session environment values must be text"))?;
        size += key.len() + value.len();
        if !valid || value.contains('\0') || size > 32 * 1024 {
            return Err(AppError::msg("Invalid session environment variable"));
        }
        result.insert(key.clone(), value.to_string());
    }
    Ok(result)
}

pub fn session_environment(workspace: &QueueWorkspace) -> HashMap<String, String> {
    let home = crate::paths::user_home().unwrap_or_default();
    workspace.session_env.iter().map(|(key, value)| {
        let resolved = if workspace.kind == "local" {
            ["$HOME/", "${HOME}/", "~/"].iter().find_map(|prefix| {
                value.strip_prefix(prefix).map(|rest| home.join(rest).to_string_lossy().into_owned())
            }).unwrap_or_else(|| value.clone())
        } else {
            value.clone()
        };
        (key.clone(), resolved)
    }).collect()
}

/// Expand a configured HOME prefix on the SSH host while quoting the rest as
/// literal text. Other values keep the existing remote export behavior.
pub fn remote_session_value(value: &str) -> String {
    if let Some(rest) = ["$HOME/", "${HOME}/", "~/"].iter().find_map(|prefix| value.strip_prefix(prefix)) {
        format!("\"$HOME\"/{}", shell_quote(rest))
    } else {
        shell_quote(value)
    }
}

pub fn script(workspace: &QueueWorkspace) -> Option<&str> {
    workspace
        .terminal_rc
        .as_deref()
        .filter(|s| !s.trim().is_empty())
}
pub fn validate_size(script: &str) -> AppResult<()> {
    if script.len() > 32 * 1024 || script.contains('\0') {
        return Err(AppError::msg(
            "RC must be at most 32 KiB and contain no NUL characters",
        ));
    }
    Ok(())
}
pub fn prelude(script: &str) -> String {
    format!("if [ -n \"${{BASH_VERSION:-}}\" ]; then shopt -s expand_aliases; elif [ -n \"${{ZSH_VERSION:-}}\" ]; then setopt aliases; else printf '%s\\n' 'Workspace RC requires bash or zsh' >&2; exit 1; fi\neval {} || exit $?\n", shell_quote(script))
}
/// Separate eval calls ensure aliases defined by RC are expanded in the command.
pub fn body(workspace: &QueueWorkspace, command: &str) -> String {
    format!(
        "cd {} || exit $?\n{}eval {}",
        shell_quote(&workspace.cwd),
        prelude(script(workspace).unwrap_or("")),
        shell_quote(command)
    )
}
pub fn remote(workspace: &QueueWorkspace, command: &str) -> String {
    format!(
        "\"${{SHELL:-/bin/bash}}\" -ilc {}",
        shell_quote(&body(workspace, command))
    )
}
pub fn local_shell() -> AppResult<String> {
    if cfg!(windows) {
        return Ok("powershell.exe".into());
    }
    Ok(std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into()))
}
pub fn is_powershell(shell: &str) -> bool {
    matches!(
        shell
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or(shell)
            .to_ascii_lowercase()
            .as_str(),
        "pwsh" | "pwsh.exe" | "powershell" | "powershell.exe"
    )
}
fn ps_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}
pub fn powershell_prelude(workspace: &QueueWorkspace) -> String {
    // Dot-source in this scope so aliases, functions and variables survive.
    format!(
        "Set-Location -LiteralPath {} -ErrorAction Stop\n. ([scriptblock]::Create({}))\n",
        ps_quote(&workspace.cwd),
        ps_quote(script(workspace).unwrap_or(""))
    )
}
pub fn powershell_args(workspace: &QueueWorkspace, command: &str, args: &[String]) -> Vec<String> {
    use base64::Engine;
    let invoke = if command.is_empty() {
        "Write-Output 'RC loaded'".into()
    } else {
        format!(
            "& {} {}",
            ps_quote(command),
            args.iter()
                .map(|v| ps_quote(v))
                .collect::<Vec<_>>()
                .join(" ")
        )
    };
    let code = format!("$ErrorActionPreference = 'Stop'\ntry {{\n{}{}\n}} catch {{ [Console]::Error.WriteLine($_.ToString()); exit 1 }}", powershell_prelude(workspace), invoke);
    let bytes: Vec<u8> = code.encode_utf16().flat_map(u16::to_le_bytes).collect();
    vec![
        "-NoLogo".into(),
        "-EncodedCommand".into(),
        base64::engine::general_purpose::STANDARD.encode(bytes),
    ]
}
pub fn local_command(
    workspace: &QueueWorkspace,
    command: &str,
    args: &[String],
) -> AppResult<(String, Vec<String>)> {
    let shell = local_shell()?;
    let argv = if is_powershell(&shell) {
        powershell_args(workspace, command, args)
    } else {
        let command = if command.is_empty() {
            "printf '%s\\n' 'RC loaded'".into()
        } else {
            format!(
                "{} {}",
                command,
                args.iter()
                    .map(|s| shell_quote(s))
                    .collect::<Vec<_>>()
                    .join(" ")
            )
        };
        vec!["-ilc".into(), body(workspace, &command)]
    };
    Ok((shell, argv))
}
pub async fn verify(workspace: &QueueWorkspace) -> AppResult<serde_json::Value> {
    validate_size(script(workspace).unwrap_or(""))?;
    let command = "printf '%s\\n' 'RC loaded'";
    let output = tokio::time::timeout(std::time::Duration::from_secs(15), async {
        if workspace.kind == "ssh" {
            let exports = session_environment(workspace).iter().map(|(key, value)| {
                format!("{key}={}", remote_session_value(value))
            }).collect::<Vec<_>>().join(" ");
            let run = remote(workspace, command);
            crate::ssh::ssh_exec(
                workspace
                    .ssh_host
                    .as_deref()
                    .ok_or_else(|| AppError::msg("Missing SSH host"))?,
                &if exports.is_empty() { run } else { format!("export {exports} && {run}") },
            )
            .await
        } else {
            let (program, args) = local_command(workspace, "", &[])?;
            let output = tokio::process::Command::new(program)
                .args(args)
                .envs(session_environment(workspace))
                .kill_on_drop(true)
                .output()
                .await?;
            if !output.status.success() {
                return Err(AppError::msg(
                    String::from_utf8_lossy(&output.stderr)
                        .chars()
                        .take(8000)
                        .collect::<String>(),
                ));
            }
            let mut bytes = output.stdout;
            bytes.extend(output.stderr);
            Ok(bytes)
        }
    })
    .await
    .map_err(|_| AppError::msg("RC verification timed out after 15 seconds"))??;
    Ok(
        serde_json::json!({"output":String::from_utf8_lossy(&output).chars().take(8000).collect::<String>()}),
    )
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    #[test]
    fn explicit_session_environment_expands_local_home_and_keeps_other_keys() {
        let workspace: QueueWorkspace = serde_json::from_value(serde_json::json!({
            "id":"env-test", "name":"Env", "kind":"local", "cwd":"/tmp", "runtimeCwd":"/tmp"
        })).unwrap();
        let mut queue = CardQueue::empty();
        queue.machine_settings.insert("local".into(), crate::models::MachineSessionSettings {
            terminal_rc: None,
            session_env: HashMap::from([
                ("CODEX_HOME".into(), "$HOME/.codex-alt".into()),
                ("CUSTOM_FLAG".into(), "enabled".into()),
            ]),
        });
        let values = session_environment(&effective_workspace(&queue, &workspace));
        assert_eq!(values.get("CUSTOM_FLAG").map(String::as_str), Some("enabled"));
        assert_eq!(values.get("CODEX_HOME").map(String::as_str),
            Some(crate::paths::user_home().unwrap().join(".codex-alt").to_string_lossy().as_ref()));
    }
    #[test]
    fn machine_settings_apply_to_all_folders_and_old_workspace_fields_are_ignored() {
        let mut queue = CardQueue::empty();
        let one: QueueWorkspace = serde_json::from_value(serde_json::json!({
            "id":"one", "name":"One", "kind":"local", "cwd":"/one", "runtimeCwd":"/one",
            "terminalRc":"old", "sessionEnv":{"CODEX_HOME":"/old"}
        })).unwrap();
        let two: QueueWorkspace = serde_json::from_value(serde_json::json!({
            "id":"two", "name":"Two", "kind":"local", "cwd":"/two", "runtimeCwd":"/two"
        })).unwrap();
        assert!(effective_workspace(&queue, &one).terminal_rc.is_none());
        assert!(effective_workspace(&queue, &one).session_env.is_empty());
        queue.machine_settings.insert("local".into(), crate::models::MachineSessionSettings {
            terminal_rc: Some("alias codex='codex'".into()),
            session_env: HashMap::from([("CODEX_HOME".into(), "/shared".into())]),
        });
        for workspace in [&one, &two] {
            let effective = effective_workspace(&queue, workspace);
            assert_eq!(effective.terminal_rc.as_deref(), Some("alias codex='codex'"));
            assert_eq!(effective.session_env.get("CODEX_HOME").map(String::as_str), Some("/shared"));
        }
    }
    #[test]
    fn remote_session_home_expands_without_interpreting_the_rest() {
        let home = tempfile::tempdir().unwrap();
        let value = "$HOME/.tclaude/$(echo BAD)'quoted";
        let command = format!("VALUE={}; printf '%s' \"$VALUE\"", remote_session_value(value));
        let output = std::process::Command::new("/bin/sh")
            .args(["-c", &command])
            .env("HOME", home.path())
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(String::from_utf8_lossy(&output.stdout),
            format!("{}/.tclaude/$(echo BAD)'quoted", home.path().display()));
    }
    #[test]
    fn aliases_environment_and_arguments_survive_local_and_remote_wrappers() {
        let dir = tempfile::tempdir().unwrap();
        let mut workspace: QueueWorkspace = serde_json::from_value(serde_json::json!({
            "id":"rc-test","name":"RC","kind":"local","cwd":dir.path(),"runtimeCwd":dir.path()
        })).unwrap();
        workspace.terminal_rc = Some("export QUE_RC_TEST=fixture-value\nfixture_target() { printf '%s|%s|%s' \"$QUE_RC_TEST\" \"$1\" \"$PWD\"; }\nalias fixture_alias=fixture_target".into());
        for shell in ["/bin/bash", "/bin/zsh"] {
            if !std::path::Path::new(shell).exists() {
                continue;
            }
            for remote_wrapper in [false, true] {
                let command = if remote_wrapper {
                    remote(&workspace, "fixture_alias 'literal $(echo BAD)' ")
                } else {
                    body(&workspace, "fixture_alias 'literal $(echo BAD)' ")
                };
                let output =
                    std::process::Command::new(if remote_wrapper { "/bin/sh" } else { shell })
                        .args(["-c", &command])
                        .env("SHELL", shell)
                        .env("HOME", dir.path())
                        .env("ZDOTDIR", dir.path())
                        .output()
                        .unwrap();
                assert!(
                    output.status.success(),
                    "{}",
                    String::from_utf8_lossy(&output.stderr)
                );
                assert_eq!(
                    String::from_utf8_lossy(&output.stdout),
                    format!("fixture-value|literal $(echo BAD)|{}", dir.path().display())
                );
            }
        }
    }
}
