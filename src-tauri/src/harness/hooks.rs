use super::install::{GlobalCtx, Host};
use super::registry::{self, Ctx, Plan};
use crate::error::{AppError, AppResult};
use crate::models::{AppSettings, QueueWorkspace};
use crate::paths::{atomic_write, signal_dir};
use crate::winproc::NoWindow;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

pub struct HookLaunch {
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
    host: Host,
    plan: Plan,
}

impl HookLaunch {
    pub fn extension_dir(&self) -> String {
        self.host.relative("extension")
    }

    pub async fn install_extension(&self) -> AppResult<()> {
        let runner = self.host.relative("extension-host.cjs");
        let entry = self.host.relative("extension/index.mjs");
        let input = serde_json::json!({
            "pluginDir": self.extension_dir(),
            "home": self.host.home.clone().or_else(|| crate::paths::user_home().map(|p| p.to_string_lossy().into_owned())),
            "remote": self.host.remote,
            "hookCommand": self.host.generic_hook_command(None),
            "hookWindows": self.host.windows,
            "hookNode": self.host.node,
            "hookPath": self.host.hook_path,
        }).to_string();
        if self.host.remote {
            let command = format!(
                "{} {} install {}",
                crate::ssh::shell_quote(&self.host.node),
                crate::ssh::shell_quote(&runner),
                crate::ssh::shell_quote(&entry)
            );
            crate::ssh::ssh_exec_stdin(self.host.host_name()?, &command, input.as_bytes()).await?;
        } else {
            use tokio::io::AsyncWriteExt;
            let mut child = tokio::process::Command::new(&self.host.node)
                .args([runner.as_str(), "install", entry.as_str()])
                .kill_on_drop(true)
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .no_window()
                .spawn()?;
            if let Some(mut stdin) = child.stdin.take() {
                stdin.write_all(input.as_bytes()).await?;
            }
            let output =
                tokio::time::timeout(std::time::Duration::from_secs(15), child.wait_with_output())
                    .await
                    .map_err(|_| AppError::msg("Extension hook installation timed out"))??;
            if !output.status.success() {
                return Err(AppError::msg(
                    String::from_utf8_lossy(&output.stderr).trim().to_string(),
                ));
            }
        }
        Ok(())
    }

    pub async fn install_launch_script(
        &self,
        launch_script: Option<(&Path, &str)>,
    ) -> AppResult<()> {
        self.host.install(&Plan::default(), launch_script).await
    }

    pub fn remote_launch_path(&self, terminal_id: &str) -> AppResult<PathBuf> {
        let home = self
            .host
            .home
            .as_deref()
            .ok_or_else(|| AppError::machine("REMOTE_HOME_UNKNOWN"))?;
        Ok(Path::new(home)
            .join(".cache/que/harness-launch")
            .join(format!("{terminal_id}.sh")))
    }

    pub async fn install(&self, launch_script: Option<(&Path, &str)>) -> AppResult<()> {
        self.host.install(&self.plan, launch_script).await
    }
}

pub async fn prepare_hook_launch(
    kind: &str,
    directory: &Path,
    workspace: &QueueWorkspace,
    token: &str,
    bin_dir: &Path,
    version: &str,
) -> AppResult<HookLaunch> {
    if workspace.kind == "local" {
        std::fs::create_dir_all(directory)?;
    }
    // The ingress is read first: a missing one has to fail the launch, and its bytes
    // also key the remote cache path.
    let ingress = std::fs::read_to_string(bin_dir.join("harness-hook.cjs"))?;
    let harness =
        registry::find(kind).ok_or_else(|| crate::error::AppError::msg("不支持的 CLI agent"))?;
    let host = Host::open(kind, workspace, token, &ingress).await?;
    let mut plan = harness
        .plan(Ctx {
            kind,
            workspace,
            host: &host,
            bin_dir,
            version,
        })
        .await?;
    if !plan.files.contains_key("hook.cjs") {
        plan.files.insert("hook.cjs".into(), ingress);
    }
    let args = std::mem::take(&mut plan.args);
    let mut env = std::mem::take(&mut plan.env);
    env.extend(host.base_env(directory));
    if !host.remote {
        let _ = signal_dir(token);
    }
    Ok(HookLaunch {
        args,
        env,
        host,
        plan,
    })
}

/// Bring plugin copies that already exist up to the running build, and report which
/// kinds were rewritten.
///
/// `HookLaunch::install` runs when a card of that kind launches. So a build that
/// ships a new ingress script leaves every kind it no longer
/// launches on the old one — Cursor in particular keeps a *current* `~/.cursor/hooks.json`
/// pointing at a stale `hook.cjs`, which fails silently. Startup closes that gap for
/// local copies; remote (SSH) copies still wait for their card, because reaching them
/// would mean opening a connection this must not start on its own.
///
/// Only `hook.cjs` is aligned: the config files are merged at launch, so a changed
/// *event list* still lands the next time that kind is launched.
pub fn sync_installed_hooks(bin_dir: &Path, plugins: &Path) -> Vec<String> {
    #[cfg(windows)]
    super::windows::sweep_legacy_hooks(plugins);
    let Ok(source) = std::fs::read_to_string(bin_dir.join("harness-hook.cjs")) else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(plugins) else {
        return Vec::new();
    };
    let mut refreshed: Vec<String> = entries
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let kind = entry.file_name().to_str()?.to_string();
            if super::extensions::find(&kind).is_some() {
                return None;
            }
            let hook = entry.path().join("hook.cjs");
            // A kind with no copy here was never installed: its card launch decides the
            // layout, and inventing one now would guess at what the launcher writes.
            if !hook.is_file()
                || std::fs::read_to_string(&hook).is_ok_and(|installed| installed == source)
            {
                return None;
            }
            atomic_write(&hook, &source).ok().map(|()| kind)
        })
        .collect();
    refreshed.sort();
    refreshed
}

/// Install the hooks that serve sessions Que never launched for every kind the
/// settings enable, and strip the entries of disabled ones — the toggle's other
/// half, so switching a kind off leaves no Que configuration behind.
pub fn sync_external_hooks(bin_dir: &Path, plugins: &Path, settings: &AppSettings) -> Vec<String> {
    let _config_lock = match super::install::lock_shared_config() {
        Ok(lock) => lock,
        Err(error) => return vec![format!("external hook config lock: {error}")],
    };
    let ctx = GlobalCtx::new(bin_dir, plugins);
    for harness in registry::ALL {
        if settings.is_external_ingress_enabled(harness.id()) {
            harness.global(&ctx);
        } else {
            harness.unglobal(&ctx);
        }
    }
    let errors = super::extensions::sync_external(bin_dir, plugins, settings);
    for error in &errors {
        crate::debuglog::log(&format!("external extension: {error}"));
    }
    errors
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, body: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }

    #[test]
    fn startup_realigns_only_the_copies_that_exist() {
        let bin = tempfile::tempdir().unwrap();
        let plugins = tempfile::tempdir().unwrap();
        let source = bin.path().join("harness-hook.cjs");
        write(&source, "new ingress");
        write(&plugins.path().join("cursor/hook.cjs"), "old ingress");
        write(&plugins.path().join("codex/hook.cjs"), "new ingress");
        // A kind that was never installed here keeps its directory and nothing else.
        std::fs::create_dir_all(plugins.path().join("pi")).unwrap();
        std::fs::write(plugins.path().join("notes.txt"), "not a plugin").unwrap();

        assert_eq!(sync_installed_hooks(bin.path(), plugins.path()), ["cursor"]);
        assert_eq!(
            std::fs::read_to_string(plugins.path().join("cursor/hook.cjs")).unwrap(),
            "new ingress"
        );
        // Up to date copies are left alone, so a second launch writes nothing.
        assert!(sync_installed_hooks(bin.path(), plugins.path()).is_empty());
        assert!(!plugins.path().join("pi/hook.cjs").exists());
    }

    #[test]
    fn a_missing_source_or_root_is_not_a_failure() {
        let bin = tempfile::tempdir().unwrap();
        let plugins = tempfile::tempdir().unwrap();
        write(&plugins.path().join("cursor/hook.cjs"), "old ingress");
        assert!(sync_installed_hooks(bin.path(), plugins.path()).is_empty());
        write(&bin.path().join("harness-hook.cjs"), "new ingress");
        assert!(sync_installed_hooks(bin.path(), &plugins.path().join("absent")).is_empty());
        assert_eq!(
            std::fs::read_to_string(plugins.path().join("cursor/hook.cjs")).unwrap(),
            "old ingress"
        );
    }
}
