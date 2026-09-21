use crate::error::AppResult;
use crate::winproc::NoWindow;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

const START: &str = "__QUE_ENV_START__";
const END: &str = "__QUE_ENV_END__";

/// The dump spawns PowerShell (Windows) or a login shell (Unix) and costs
/// seconds per call; the result only seeds child env and command resolution,
/// so reuse a fresh snapshot. Windows returns a stale snapshot immediately
/// while refreshing in the background; edits no longer require an app restart.
/// First capture and explicit refresh are bounded and share one capture lock.
const ENV_CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(60);
const ENV_CAPTURE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
static ENV_CACHE: tokio::sync::Mutex<Option<(std::time::Instant, HashMap<String, String>)>> =
    tokio::sync::Mutex::const_new(None);
static ENV_REFRESH: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

pub async fn local_environment(force: bool) -> AppResult<HashMap<String, String>> {
    if !force {
        let cached = ENV_CACHE.lock().await.clone();
        if let Some((at, env)) = cached {
            if at.elapsed() < ENV_CACHE_TTL {
                return Ok(env);
            }
            if cfg!(windows) {
                if let Ok(guard) = ENV_REFRESH.try_lock() {
                    // Throttle failed refreshes as well; keep the last good value.
                    if let Some((at, _)) = ENV_CACHE.lock().await.as_mut() {
                        *at = std::time::Instant::now();
                    }
                    tokio::spawn(async move {
                        let _guard = guard;
                        if let Err(error) = refresh_environment().await {
                            crate::debuglog::info(
                                "harness",
                                &format!("background shell environment refresh failed: {error}"),
                            );
                        }
                    });
                }
                return Ok(env);
            }
        }
    }
    let _guard = ENV_REFRESH.lock().await;
    // Another first launch may already have filled the cache while we waited.
    if !force {
        if let Some((at, env)) = ENV_CACHE.lock().await.as_ref() {
            if at.elapsed() < ENV_CACHE_TTL {
                return Ok(env.clone());
            }
        }
    }
    refresh_environment().await
}

async fn refresh_environment() -> AppResult<HashMap<String, String>> {
    let env = dump_local_environment().await?;
    *ENV_CACHE.lock().await = Some((std::time::Instant::now(), env.clone()));
    Ok(env)
}

async fn bounded_output(
    command: &mut tokio::process::Command,
    timeout: std::time::Duration,
) -> AppResult<std::process::Output> {
    command
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true)
        .no_window();
    tokio::time::timeout(timeout, command.output())
        .await
        .map_err(|_| crate::error::AppError::msg("读取用户 Shell 环境超时，请检查 Shell 启动配置"))?
        .map_err(|e| crate::error::AppError::msg(format!("读取用户 Shell 环境失败：{e}")))
}

async fn dump_local_environment() -> AppResult<HashMap<String, String>> {
    let mut process = if cfg!(windows) {
        let command = format!(
            "$e=@{{}};[Environment]::GetEnvironmentVariables().GetEnumerator()|ForEach-Object{{$e[$_.Key]=[string]$_.Value}};[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);[Console]::Write('{START}');[Console]::Write(($e|ConvertTo-Json -Compress));[Console]::Write('{END}')"
        );
        let mut process = tokio::process::Command::new("powershell.exe");
        if crate::paths::is_test_profile() {
            process.arg("-NoProfile");
        }
        process.args(["-NoLogo", "-NonInteractive", "-Command", &command]);
        process
    } else {
        let command = format!("printf '{START}\\0'; /usr/bin/env -0; printf '{END}\\0'");
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
        let mut process = tokio::process::Command::new(shell);
        process.args([
            if crate::paths::is_test_profile() {
                "-c"
            } else {
                "-ilc"
            },
            &command,
        ]);
        process
    };
    let output = bounded_output(&mut process, ENV_CAPTURE_TIMEOUT).await?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let start = stdout
        .find(START)
        .ok_or_else(|| crate::error::AppError::machine("HARNESS_ENV_UNREADABLE"))?;
    let end = stdout[start + START.len()..]
        .find(END)
        .ok_or_else(|| crate::error::AppError::machine("HARNESS_ENV_UNREADABLE"))?;
    let body = &stdout[start + START.len()..start + START.len() + end];
    let mut env: HashMap<String, String> = std::env::vars().collect();
    if cfg!(windows) {
        let parsed = serde_json::from_str::<HashMap<String, String>>(body)
            .map_err(|_| crate::error::AppError::machine("HARNESS_ENV_UNREADABLE"))?;
        for (key, value) in parsed {
            env.retain(|k, _| !k.eq_ignore_ascii_case(&key));
            env.insert(key, value);
        }
    } else {
        for item in body.split('\0').filter(|s| s.contains('=')) {
            if let Some((key, value)) = item.split_once('=') {
                env.insert(key.to_string(), value.to_string());
            }
        }
    }
    Ok(env)
}

pub fn resolve_local_command(
    command: &str,
    env: &HashMap<String, String>,
    extra_dirs: &[PathBuf],
) -> Option<String> {
    let read = |key: &str| {
        env.iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(key))
            .map(|(_, v)| v.clone())
    };
    let path = read("PATH").unwrap_or_default();
    let sep = if cfg!(windows) { ';' } else { ':' };
    let mut dirs: Vec<PathBuf> = path
        .split(sep)
        .filter(|s| Path::new(s).is_absolute())
        .map(PathBuf::from)
        .collect();
    if let Some(home) = crate::paths::user_home() {
        dirs.push(home.join(".local/bin"));
        // A harness whose CLI may hide in a directory of its own names it.
        for dir in extra_dirs {
            dirs.push(home.join(dir));
        }
    }
    if cfg!(windows) {
        if let Some(appdata) = read("APPDATA") {
            dirs.push(PathBuf::from(appdata).join("npm"));
        }
    }
    let extensions: Vec<String> = if cfg!(windows) {
        read("PATHEXT")
            .unwrap_or_else(|| ".EXE;.CMD;.BAT;.COM".into())
            .split(';')
            .map(|s| s.to_string())
            .collect()
    } else {
        vec![String::new()]
    };
    for dir in dirs {
        // A PATH entry behind a user-created junction refuses traversal when
        // the process inherits the redirection-trust mitigation (MSI "launch
        // now", sshd). Resolve the link targets — pure metadata reads the
        // mitigation does not gate — and probe the physical path instead.
        #[cfg(windows)]
        let dir = if dir.is_dir() {
            dir
        } else {
            resolve_reparse_chain(&dir)
        };
        for ext in &extensions {
            let candidate = dir.join(format!("{command}{ext}"));
            if candidate.is_file() {
                return Some(candidate.to_string_lossy().into_owned());
            }
        }
    }
    None
}

/// Substitute every reparse point in `path` with its link target, one component
/// at a time so ancestors are already physical before each lookup. Repeat until
/// stable: a target may itself contain links (Codex's `bin` junction lands on a
/// `current` junction). Unreadable or nonexistent parts are left as-is; the
/// caller's `is_file` still decides.
#[cfg(windows)]
fn resolve_reparse_chain(path: &Path) -> PathBuf {
    use std::os::windows::fs::MetadataExt;
    const REPARSE_POINT: u32 = 0x400;
    let mut current = path.to_path_buf();
    for _ in 0..8 {
        let mut resolved = PathBuf::new();
        let mut changed = false;
        for component in current.components() {
            resolved.push(component.as_os_str());
            let Ok(meta) = std::fs::symlink_metadata(&resolved) else {
                continue;
            };
            if meta.file_attributes() & REPARSE_POINT == 0 {
                continue;
            }
            let Ok(target) = std::fs::read_link(&resolved) else {
                continue;
            };
            resolved = if target.is_absolute() {
                target
            } else {
                resolved
                    .parent()
                    .map(|base| base.join(&target))
                    .unwrap_or(target)
            };
            changed = true;
        }
        if !changed {
            break;
        }
        current = resolved;
    }
    current
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn stalled_capture_times_out_instead_of_holding_launches_forever() {
        let mut command = if cfg!(windows) {
            let mut cmd = tokio::process::Command::new("powershell.exe");
            cmd.args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Start-Sleep -Seconds 30",
            ]);
            cmd
        } else {
            let mut cmd = tokio::process::Command::new("sh");
            cmd.args(["-c", "exec sleep 30"]);
            cmd
        };
        let start = std::time::Instant::now();
        assert!(
            bounded_output(&mut command, std::time::Duration::from_millis(100))
                .await
                .is_err()
        );
        assert!(start.elapsed() < std::time::Duration::from_secs(3));
    }
}
