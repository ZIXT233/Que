//! Explicit, workspace-owned startup configuration. Never writes global rc files.
use crate::{
    error::{AppError, AppResult},
    models::QueueWorkspace,
    ssh::shell_quote,
};

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
            crate::ssh::ssh_exec(
                workspace
                    .ssh_host
                    .as_deref()
                    .ok_or_else(|| AppError::msg("Missing SSH host"))?,
                &remote(workspace, command),
            )
            .await
        } else {
            let (program, args) = local_command(workspace, "", &[])?;
            let output = tokio::process::Command::new(program)
                .args(args)
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
    fn aliases_environment_and_arguments_survive_local_and_remote_wrappers() {
        let dir = tempfile::tempdir().unwrap();
        let workspace: QueueWorkspace = serde_json::from_value(serde_json::json!({
            "id":"rc-test","name":"RC","kind":"local","cwd":dir.path(),"runtimeCwd":dir.path(),
            "terminalRc":"export QUE_RC_TEST=fixture-value\nfixture_target() { printf '%s|%s|%s' \"$QUE_RC_TEST\" \"$1\" \"$PWD\"; }\nalias fixture_alias=fixture_target"
        })).unwrap();
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
