//! The shell card: no CLI and no hooks — its state comes off the PTY, from the shell
//! integration scripts' OSC 133 marks.

use super::registry::Harness;
use crate::error::AppResult;
use crate::models::QueueWorkspace;
use crate::paths::signal_dir;
use crate::ssh::{shell_quote, ssh_exec};
use crate::terminal::Spawn;
use std::collections::HashMap;
use std::path::Path;

pub struct ShellLaunch {
    pub spawn: Spawn,
    pub version: String,
    pub command_notifications: bool,
}

/// Remote (ssh) paths must always use forward slashes; joining PathBuf on
/// Windows injects backslashes that break remote mkdir/cd commands.
fn forward(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

pub async fn prepare_shell(
    workspace: &QueueWorkspace,
    card_id: &str,
    directory: &Path,
    bin_dir: &Path,
    powershell: bool,
    use_tmux: bool,
) -> AppResult<ShellLaunch> {
    let remote = workspace.kind == "ssh";
    let mut shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
    let mut root = directory.to_path_buf();
    let mut user_home = crate::paths::user_home().unwrap_or_else(|| Path::new(".").to_path_buf());
    let mut original_zdotdir = std::env::var("ZDOTDIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| user_home.clone());
    if remote {
        let host = workspace
            .ssh_host
            .as_deref()
            .ok_or_else(|| crate::error::AppError::machine("WORKSPACE_MISSING"))?;
        let facts = String::from_utf8_lossy(
            &ssh_exec(
                host,
                r#"printf "%s\n%s\n%s" "$HOME" "${SHELL:-/bin/bash}" "${ZDOTDIR:-$HOME}""#,
            )
            .await?,
        )
        .to_string();
        let mut lines = facts.lines();
        if let Some(home) = lines.next() {
            user_home = Path::new(home).to_path_buf();
        }
        if let Some(value) = lines.next() {
            shell = value.to_string();
        }
        if let Some(value) = lines.next() {
            original_zdotdir = Path::new(value).to_path_buf();
        }
        root = user_home
            .join(".cache/que/shell")
            .join(directory.file_name().unwrap_or_default());
    }
    let mut files: HashMap<String, String> = HashMap::new();
    let args;
    let mut command_notifications = true;
    let mut env: HashMap<String, String> = HashMap::new();
    let name = Path::new(&shell)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    if !remote && cfg!(windows) && powershell {
        shell = "powershell.exe".into();
        let script = std::fs::read_to_string(bin_dir.join("shell/powershell-integration.ps1"))?;
        let encoded = utf16_le_base64(&script);
        args = vec![
            "-NoLogo".into(),
            "-NoExit".into(),
            "-EncodedCommand".into(),
            encoded,
        ];
    } else if name == "zsh" {
        files.insert(
            "integration.sh".into(),
            std::fs::read_to_string(bin_dir.join("shell/zsh-integration.sh"))?,
        );
        files.insert(".zshenv".into(), format!(
            "ZDOTDIR={}\n[[ -r \"$ZDOTDIR/.zshenv\" ]] && source \"$ZDOTDIR/.zshenv\"\nexport QUE_USER_ZDOTDIR=\"${{ZDOTDIR:-$HOME}}\"\nexport ZDOTDIR={}\n",
            shell_quote(&original_zdotdir.to_string_lossy()),
            shell_quote(&root.to_string_lossy())
        ));
        files.insert(
            ".zprofile".into(),
            "[[ -r \"$QUE_USER_ZDOTDIR/.zprofile\" ]] && source \"$QUE_USER_ZDOTDIR/.zprofile\"\n"
                .into(),
        );
        files.insert(".zshrc".into(), format!(
            "ZDOTDIR=\"$QUE_USER_ZDOTDIR\"\n[[ -r \"$ZDOTDIR/.zshrc\" ]] && source \"$ZDOTDIR/.zshrc\"\nunset QUE_USER_ZDOTDIR\nsource {}\n",
            shell_quote(&root.join("integration.sh").to_string_lossy())
        ));
        env.insert("ZDOTDIR".into(), root.to_string_lossy().into_owned());
        args = vec!["-il".into()];
    } else if name == "bash" {
        let integration = std::fs::read_to_string(bin_dir.join("shell/bash-integration.sh"))?;
        files.insert(
            "bashrc".into(),
            format!("[[ -r \"$HOME/.bashrc\" ]] && source \"$HOME/.bashrc\"\n{integration}"),
        );
        let rcfile = if remote {
            format!("{}/bashrc", forward(&root))
        } else {
            root.join("bashrc").to_string_lossy().into_owned()
        };
        args = vec!["--rcfile".into(), rcfile, "-i".into()];
    } else {
        args = vec!["-il".into()];
        command_notifications = false;
    }
    if remote {
        let host = workspace.ssh_host.as_deref().unwrap();
        ssh_exec(
            host,
            &format!("umask 077; mkdir -p {}", shell_quote(&forward(&root))),
        )
        .await?;
        for (name, body) in &files {
            ssh_exec(
                host,
                &format!(
                    "printf %s {} > {}",
                    shell_quote(body),
                    shell_quote(&format!("{}/{}", forward(&root), name))
                ),
            )
            .await?;
        }
        let exports = env
            .iter()
            .map(|(k, v)| format!("{k}={}", shell_quote(v)))
            .collect::<Vec<_>>()
            .join(" ");
        let command = std::iter::once(shell.clone())
            .chain(args)
            .map(|s| shell_quote(&s))
            .collect::<Vec<_>>()
            .join(" ");
        let term_id = format!("card_{card_id}");
        let remote_cmd = if use_tmux {
            let inner_exec = format!(
                "{}exec {}",
                if exports.is_empty() {
                    String::new()
                } else {
                    format!("export {exports} && ")
                },
                command
            );
            let wrapped = crate::ssh::wrap_remote_tmux(&term_id, &workspace.cwd, &inner_exec);
            crate::ssh::ssh_login_command(&format!(
                "cd {} && {}",
                shell_quote(&workspace.cwd),
                wrapped
            ))
        } else {
            format!(
                "cd {} && {}exec {}",
                shell_quote(&workspace.cwd),
                if exports.is_empty() {
                    String::new()
                } else {
                    format!("export {exports} && ")
                },
                command
            )
        };
        // The remote side's sshd allocates the pty for this command; there is no
        // local ssh process and therefore no local pty to go with it.
        return Ok(ShellLaunch {
            spawn: Spawn::Remote {
                host: host.to_string(),
                command: remote_cmd,
            },
            version: String::new(),
            command_notifications,
        });
    }
    if !files.is_empty() {
        std::fs::create_dir_all(&root)?;
        for (name, body) in files {
            std::fs::write(root.join(name), body)?;
        }
    }
    let _ = signal_dir("unused");
    Ok(ShellLaunch {
        spawn: Spawn::Local {
            executable: shell,
            args,
            env,
        },
        version: String::new(),
        command_notifications,
    })
}

/// The OSC 133 marks the integration scripts write around each command.
pub fn probe_chunk(data: &str) -> Option<(bool, Option<i32>)> {
    if data.contains("\x1b]133;C") {
        return Some((true, None));
    }
    if let Some(index) = data.find("\x1b]133;D") {
        let rest = &data[index + 7..];
        let code = rest
            .chars()
            .take_while(|c| c.is_ascii_digit())
            .collect::<String>()
            .parse()
            .ok();
        return Some((false, code));
    }
    None
}

fn utf16_le_base64(value: &str) -> String {
    let bytes: Vec<u8> = value.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    base64::Engine::encode(&base64::engine::general_purpose::STANDARD, bytes)
}

pub struct Shell;

pub static SHELL: Shell = Shell;

impl Harness for Shell {
    fn id(&self) -> &'static str {
        "shell"
    }
    // `adapter()` stays `None`: a shell card runs no CLI at all, so the launch
    // pipeline falls back to `prepare_shell`, and there is no session of its own to
    // resume.

    fn notify_probe(&self) -> bool {
        false
    }

    fn refresh_probe_label(&self) -> bool {
        false
    }
}
