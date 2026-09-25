//! User-owned Node modules registered at runtime as harness extensions.
use super::registry::{Adapter, Ctx, Harness, Plan};
use crate::error::{AppError, AppResult};
use crate::winproc::NoWindow;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::future::Future;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{LazyLock, OnceLock, RwLock};
use std::time::{Duration, Instant};

static REGISTERED: LazyLock<RwLock<HashMap<String, &'static ExtensionHarness>>> =
    LazyLock::new(|| RwLock::new(HashMap::new()));
static LAST_ERRORS: LazyLock<RwLock<Vec<String>>> = LazyLock::new(|| RwLock::new(Vec::new()));
static NODE: OnceLock<PathBuf> = OnceLock::new();

pub fn node_binary() -> AppResult<PathBuf> {
    if let Some(path) = NODE.get() {
        return Ok(path.clone());
    }
    let path = which::which("node")
        .ok()
        .or_else(|| {
            #[cfg(unix)]
            {
                let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
                let mut command = std::process::Command::new(shell);
                command.args(["-ilc", "command -v node"]);
                let output = bounded_output(command, Duration::from_secs(5)).ok()?;
                if !output.status.success() {
                    return None;
                }
                String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .rev()
                    .map(str::trim)
                    .map(PathBuf::from)
                    .find(|path| path.is_absolute() && path.is_file())
            }
            #[cfg(not(unix))]
            {
                None
            }
        })
        .ok_or_else(|| AppError::machine("HARNESS_NODE_MISSING"))?;
    let _ = NODE.set(path.clone());
    Ok(path)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionInfo {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub external: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon_data_url: Option<String>,
}

pub struct ExtensionHarness {
    id: &'static str,
    info: ExtensionInfo,
    source: PathBuf,
}

fn no_resume_args(_: &str) -> AppResult<Vec<String>> {
    Ok(Vec::new())
}

impl Harness for ExtensionHarness {
    fn id(&self) -> &'static str {
        self.id
    }

    // The executable is resolved from the module per launch. An adapter marks
    // this as a CLI card so the existing signal/PTY pipeline stays in use.
    fn adapter(&self) -> Option<Adapter> {
        Some(Adapter::new("node", &[], no_resume_args))
    }

    fn plan<'a>(
        &'a self,
        ctx: Ctx<'a>,
    ) -> Pin<Box<dyn Future<Output = AppResult<Plan>> + Send + 'a>> {
        Box::pin(async move {
            let mut plan = Plan::default();
            collect_files(&self.source, &self.source, &mut plan.files)?;
            plan.files.insert(
                "extension-host.cjs".into(),
                std::fs::read_to_string(ctx.bin_dir.join("extension-host.cjs"))?,
            );
            plan.files.insert(
                "hook.cjs".into(),
                "const path=require('node:path');const host=require('./extension-host.cjs');process.argv.splice(2,0,'hook',path.join(__dirname,'extension','index.mjs'));host.main().catch(error=>{process.stderr.write(`Que extension: ${error.message||error}\\n`);process.exitCode=1});\n".into(),
            );
            Ok(plan)
        })
    }
}

fn collect_files(
    root: &Path,
    directory: &Path,
    files: &mut HashMap<String, String>,
) -> AppResult<()> {
    for entry in std::fs::read_dir(directory)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        if ty.is_symlink() {
            return Err(AppError::msg("Extension symlinks are unsupported"));
        }
        if ty.is_dir() {
            collect_files(root, &entry.path(), files)?;
        } else if ty.is_file() {
            let relative = entry
                .path()
                .strip_prefix(root)
                .map_err(|_| AppError::msg("Invalid extension path"))?
                .to_path_buf();
            let name = relative.to_string_lossy().replace('\\', "/");
            if name.split('/').any(|part| part.is_empty() || part == "..") {
                return Err(AppError::msg("Invalid extension file"));
            }
            files.insert(
                format!("extension/{name}"),
                std::fs::read_to_string(entry.path())?,
            );
        }
    }
    Ok(())
}

pub fn find(kind: &str) -> Option<&'static ExtensionHarness> {
    REGISTERED.read().ok()?.get(kind).copied()
}

pub fn list() -> Vec<ExtensionInfo> {
    let mut values: Vec<_> = REGISTERED
        .read()
        .map(|map| map.values().map(|h| h.info.clone()).collect())
        .unwrap_or_default();
    values.sort_by(|a: &ExtensionInfo, b: &ExtensionInfo| a.name.cmp(&b.name));
    values
}

pub fn errors() -> Vec<String> {
    LAST_ERRORS.read().map(|errors| errors.clone()).unwrap_or_default()
}

fn record_errors(errors: Vec<String>) -> Vec<String> {
    if let Ok(mut last) = LAST_ERRORS.write() {
        *last = errors.clone();
    }
    errors
}

fn bundled_root(bin_dir: &Path) -> PathBuf {
    #[cfg(debug_assertions)]
    {
        let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples/harness-extensions");
        if source.is_dir() {
            return source;
        }
    }
    bin_dir.parent().unwrap_or(bin_dir).join("extensions")
}

pub fn refresh(bin_dir: &Path) -> Vec<String> {
    let runner = bin_dir.join("extension-host.cjs");
    let mut found = HashMap::new();
    let mut errors = Vec::new();
    let node = match node_binary() {
        Ok(node) => node,
        Err(error) => return record_errors(vec![error.to_string()]),
    };
    // Bundled extensions take precedence so app updates cannot be shadowed by
    // a stale copy left in the user's extension directory.
    for (bundled, root) in [
        (true, bundled_root(bin_dir)),
        (false, crate::paths::data_dir().join("extensions")),
    ] {
        let entries = match std::fs::read_dir(&root) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && !bundled => continue,
            Err(error) => {
                errors.push(format!("{}: {error}", root.display()));
                continue;
            }
        };
        for entry in entries.flatten() {
            let Ok(ty) = entry.file_type() else { continue };
            if !ty.is_dir() {
                continue;
            }
            let directory_id = entry.file_name().to_string_lossy().into_owned();
            if found.contains_key(&directory_id) {
                continue;
            }
            let source = entry.path();
            let index = source.join("index.mjs");
            if !index.is_file() {
                continue;
            }
            let output = discover(&node, &runner, &index);
            let result: Result<ExtensionInfo, String> = match output {
                Ok(output) if output.status.success() => {
                    serde_json::from_slice(&output.stdout).map_err(|e| e.to_string())
                }
                Ok(output) => Err(String::from_utf8_lossy(&output.stderr).trim().to_string()),
                Err(error) => Err(error.to_string()),
            };
            match result {
                Ok(info)
                    if info.id == directory_id
                        && super::registry::builtin(&info.id).is_none()
                        && !found.contains_key(&info.id) =>
                {
                    let previous = REGISTERED
                        .read()
                        .ok()
                        .and_then(|map| map.get(&info.id).copied());
                    let harness: &'static ExtensionHarness = if let Some(old) =
                        previous.filter(|old| old.info == info && old.source == source)
                    {
                        old
                    } else {
                        let id: &'static str = Box::leak(info.id.clone().into_boxed_str());
                        Box::leak(Box::new(ExtensionHarness { id, info, source }))
                    };
                    found.insert(harness.id.to_string(), harness);
                }
                Ok(info) => errors.push(format!(
                    "{}: invalid or duplicate id {}",
                    index.display(),
                    info.id
                )),
                Err(error) => errors.push(format!("{}: {error}", index.display())),
            }
        }
    }
    *REGISTERED.write().unwrap() = found;
    record_errors(errors)
}

fn discover(node: &Path, runner: &Path, index: &Path) -> std::io::Result<std::process::Output> {
    let mut command = std::process::Command::new(node);
    command.arg(runner).arg("discover").arg(index);
    bounded_output(command, Duration::from_secs(5))
}

fn bounded_output(
    mut command: std::process::Command,
    timeout: Duration,
) -> std::io::Result<std::process::Output> {
    command.no_window();
    let child = command
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()?;
    wait_output(child, timeout)
}

fn wait_output(
    mut child: std::process::Child,
    timeout: Duration,
) -> std::io::Result<std::process::Output> {
    let deadline = Instant::now() + timeout;
    loop {
        if child.try_wait()?.is_some() {
            return child.wait_with_output();
        }
        if Instant::now() >= deadline {
            child.kill()?;
            let _ = child.wait();
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "extension registration timed out",
            ));
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// Reconcile the user-level hook install for sessions started outside Que.
/// A copied module remains available for uninstall after its source is removed.
pub fn sync_external(
    bin_dir: &Path,
    plugins: &Path,
    settings: &crate::models::AppSettings,
) -> Vec<String> {
    let mut errors = Vec::new();
    let active: Vec<_> = list()
        .into_iter()
        .filter(|info| info.external && settings.is_external_ingress_enabled(&info.id))
        .collect();
    let installed: Vec<_> = match std::fs::read_dir(plugins) {
        Ok(entries) => entries
            .flatten()
            .filter_map(|entry| {
                let kind = entry.file_name().to_string_lossy().into_owned();
                let root = entry.path().join("global");
                root.join("external-enabled")
                    .is_file()
                    .then_some((kind, root))
            })
            .collect(),
        Err(_) => Vec::new(),
    };
    if active.is_empty() && installed.is_empty() {
        return errors;
    }
    let node = match node_binary() {
        Ok(node) => node,
        Err(error) => return vec![error.to_string()],
    };
    let home = crate::paths::user_home().unwrap_or_else(|| PathBuf::from("."));
    let sink = crate::paths::external_signal_dir();
    for (kind, root) in installed {
        let enabled = find(&kind)
            .is_some_and(|h| h.info.external && settings.is_external_ingress_enabled(&kind));
        if !enabled {
            match external_callback(&node, &root, &home, &sink, "uninstall-external") {
                Ok(()) => {
                    if let Err(error) = std::fs::remove_file(root.join("external-enabled")) {
                        errors.push(format!("{kind}: {error}"));
                    }
                }
                Err(error) => errors.push(format!("{kind}: {error}")),
            }
        }
    }
    for info in active {
        let Some(harness) = find(&info.id) else {
            continue;
        };
        let root = plugins.join(&info.id).join("global");
        let marker = root.join("external-enabled");
        let result = (|| -> AppResult<()> {
            let mut files = HashMap::new();
            collect_files(&harness.source, &harness.source, &mut files)?;
            files.insert(
                "extension-host.cjs".into(),
                std::fs::read_to_string(bin_dir.join("extension-host.cjs"))?,
            );
            let sink_json = serde_json::to_string(&sink.to_string_lossy().as_ref())?;
            files.insert("hook.cjs".into(), format!(
                "if(process.env.QUE_HARNESS_SIGNAL_DIR||process.env.QUE_HARNESS_CHANNEL)process.exit(0);process.env.QUE_HARNESS_EXTERNAL_SIGNAL_DIR={sink_json};const path=require('node:path');const host=require('./extension-host.cjs');process.argv.splice(2,0,'hook',path.join(__dirname,'extension','index.mjs'));host.main().catch(error=>{{process.stderr.write(`Que extension: ${{error.message||error}}\\n`);process.exitCode=1}});\n"
            ));
            let mut names: Vec<_> = files.keys().cloned().collect();
            names.sort();
            let mut hash = Sha256::new();
            for name in &names {
                hash.update(name.as_bytes());
                hash.update(files[name].as_bytes());
            }
            let digest = hex::encode(hash.finalize());
            if std::fs::read_to_string(&marker).ok().as_deref() == Some(&digest) {
                return Ok(());
            }
            if marker.is_file() {
                external_callback(&node, &root, &home, &sink, "uninstall-external")?;
                std::fs::remove_file(&marker)?;
            }
            for name in names {
                let target = root.join(&name);
                if let Some(parent) = target.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                crate::paths::atomic_write(&target, &files[&name])?;
            }
            external_callback(&node, &root, &home, &sink, "install-external")?;
            crate::paths::atomic_write(&marker, &digest)?;
            Ok(())
        })();
        if let Err(error) = result {
            errors.push(format!("{}: {error}", info.id));
        }
    }
    errors
}

fn external_callback(
    node: &Path,
    root: &Path,
    home: &Path,
    sink: &Path,
    mode: &str,
) -> AppResult<()> {
    let hook = root.join("hook.cjs");
    let command = if cfg!(windows) {
        super::windows::windows_hook_command(&node.to_string_lossy(), &hook.to_string_lossy(), None)
    } else {
        format!(
            "{} {}",
            crate::ssh::shell_quote(&node.to_string_lossy()),
            crate::ssh::shell_quote(&hook.to_string_lossy())
        )
    };
    let input = json!({
        "pluginDir": root.join("extension"),
        "home": home,
        "externalSignalDir": sink,
        "hookCommand": command,
        "hookWindows": cfg!(windows),
        "hookNode": node,
        "hookPath": hook,
    })
    .to_string();
    let mut child = std::process::Command::new(node)
        .arg(root.join("extension-host.cjs"))
        .arg(mode)
        .arg(root.join("extension/index.mjs"))
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .no_window()
        .spawn()?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(input.as_bytes())?;
    }
    let output = wait_output(child, Duration::from_secs(15))?;
    if !output.status.success() {
        return Err(AppError::msg(
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
        ));
    }
    Ok(())
}

#[derive(Deserialize)]
pub struct CommandSpec {
    pub command: String,
    pub args: Vec<String>,
}

pub async fn command(
    kind: &str,
    mode: &str,
    workspace: &crate::models::QueueWorkspace,
    session_id: Option<&str>,
    plugin_dir: &str,
    bin_dir: &Path,
) -> AppResult<CommandSpec> {
    let extension = find(kind).ok_or_else(|| AppError::machine("HARNESS_UNSUPPORTED"))?;
    let entry = extension.source.join("index.mjs");
    let input = json!({"cwd":workspace.cwd,"remote":workspace.kind=="ssh","pluginDir":plugin_dir,"sessionId":session_id});
    let mut child = tokio::process::Command::new(node_binary()?)
        .arg(bin_dir.join("extension-host.cjs"))
        .arg(mode)
        .arg(entry)
        .kill_on_drop(true)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .no_window()
        .spawn()?;
    use tokio::io::AsyncWriteExt;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(input.to_string().as_bytes()).await?;
    }
    let output = tokio::time::timeout(Duration::from_secs(10), child.wait_with_output())
        .await
        .map_err(|_| AppError::msg("Extension launch callback timed out"))??;
    if !output.status.success() {
        return Err(AppError::msg(
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
        ));
    }
    Ok(serde_json::from_slice(&output.stdout)?)
}
