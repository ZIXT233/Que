use std::path::{Path, PathBuf};

#[cfg(feature = "headless-e2e")]
static TEST_HOME: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

pub fn user_home() -> Option<PathBuf> {
    #[cfg(feature = "headless-e2e")]
    if let Some(home) = TEST_HOME.get() {
        return Some(home.clone());
    }
    dirs::home_dir()
}

pub fn is_test_profile() -> bool {
    #[cfg(feature = "headless-e2e")]
    {
        return TEST_HOME.get().is_some();
    }
    #[cfg(not(feature = "headless-e2e"))]
    {
        false
    }
}

#[cfg(feature = "headless-e2e")]
pub(crate) fn set_test_home(home: PathBuf) {
    TEST_HOME
        .set(home)
        .expect("headless home may only be initialized once");
}

pub fn data_dir() -> PathBuf {
    if let Ok(path) = std::env::var("QUE_DATA_DIR") {
        return expand_user(&path);
    }
    #[cfg(debug_assertions)]
    {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".que-dev")
    }
    #[cfg(not(debug_assertions))]
    {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".que")
    }
}

pub fn queue_file() -> PathBuf {
    if let Ok(path) = std::env::var("QUE_QUEUE_FILE") {
        return PathBuf::from(path);
    }
    data_dir().join("queue.json")
}

pub fn remote_hosts_file() -> PathBuf {
    if let Ok(path) = std::env::var("QUE_REMOTE_HOSTS") {
        return PathBuf::from(path);
    }
    data_dir().join("remote-hosts.json")
}

pub fn remote_host_visibility_file() -> PathBuf {
    data_dir().join("remote-host-visibility.json")
}

pub fn settings_file() -> PathBuf {
    data_dir().join("settings.json")
}

pub fn logs_dir() -> PathBuf {
    data_dir().join("logs")
}

pub fn signal_dir(terminal_id: &str) -> PathBuf {
    data_dir().join("harness-signals").join(terminal_id)
}

/// Signals from sessions Que never launched. Cursor's user-level `hooks.json` is
/// global, so IDE chats and other terminals report here; they have no terminal id
/// and must never be mistaken for a queue card.
pub fn external_signal_dir() -> PathBuf {
    if let Ok(path) = std::env::var("QUE_EXTERNAL_SIGNAL_DIR") {
        return PathBuf::from(path);
    }
    data_dir().join("external-signals")
}

/// Que's per-CLI hook plugins. Each kind owns one directory of files here.
pub fn plugins_dir() -> PathBuf {
    data_dir().join("harness-plugins")
}

pub fn plugin_root(kind: &str) -> PathBuf {
    plugins_dir().join(kind)
}

pub fn ssh_runtime_dir(workspace_id: &str) -> PathBuf {
    data_dir().join("ssh").join(workspace_id)
}

pub fn expand_user(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/") {
        return dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(rest);
    }
    if path == "~" {
        return dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    }
    PathBuf::from(path)
}

pub fn atomic_write(path: &Path, body: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = parent_tmp(path);
    std::fs::write(&tmp, body)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(tmp, path)?;
    Ok(())
}

fn parent_tmp(path: &Path) -> PathBuf {
    let name = format!(
        ".{}.{}.tmp",
        path.file_name().and_then(|s| s.to_str()).unwrap_or("file"),
        std::process::id()
    );
    path.parent().unwrap_or_else(|| Path::new(".")).join(name)
}

pub fn resolve_bin_dir(resource_dir: Option<PathBuf>) -> PathBuf {
    if let Ok(path) = std::env::var("QUE_BIN_DIR") {
        return PathBuf::from(path);
    }
    if let Some(dir) = resource_dir {
        let candidate = dir.join("resources").join("bin");
        if candidate.exists() {
            return candidate;
        }
        let candidate = dir.join("bin");
        if candidate.exists() {
            return candidate;
        }
    }
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    if cwd.join("bin").join("harness-hook.cjs").exists() {
        return cwd.join("bin");
    }
    if cwd
        .join("src-tauri")
        .join("resources")
        .join("bin")
        .join("harness-hook.cjs")
        .exists()
    {
        return cwd.join("src-tauri").join("resources").join("bin");
    }
    cwd.join("bin")
}
