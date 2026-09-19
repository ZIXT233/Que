//! The mechanics every harness install shares: where a harness's plugin lives on the
//! machine it is going to, how its hook command is spelled, how its files get there, and
//! what environment a card needs.
//!
//! A harness itself describes only its differences — through its [`Harness`] impl in
//! `kinds/<kind>.rs`, which this module consults wherever a per-kind fact is needed.

use super::registry::{self, Harness, Plan};
use crate::error::{AppError, AppResult};
use crate::models::QueueWorkspace;
use crate::paths::{atomic_write, plugin_root};
use crate::ssh::{shell_quote, ssh_exec, ssh_login_exec};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Writes a whole file map under the plugin root in one round trip.
const PUSH: &str = r#"const fs=require("node:fs"),p=require("node:path"),root=process.argv[1];for(const [name,body] of Object.entries(JSON.parse(Buffer.from(process.argv[2],"base64")))){const f=p.join(root,name);fs.mkdirSync(p.dirname(f),{recursive:true,mode:448});const tmp=f+"."+require("node:crypto").randomUUID()+".tmp";fs.writeFileSync(tmp,body,{mode:384});fs.renameSync(tmp,f);}"#;

/// The machine one harness install is going to.
pub struct Host {
    pub kind: String,
    /// The harness this install belongs to, resolved once from the registry.
    pub harness: &'static dyn Harness,
    pub remote: bool,
    /// Whether hook commands need local Windows quoting and executable resolution.
    pub windows: bool,
    /// Where the plugin's files land: the local plugins dir, or the remote cache path.
    pub root: PathBuf,
    /// Absolute path of the ingress script on that machine.
    pub hook_path: String,
    pub node: String,
    /// The hook deadline the CLI is told about, in seconds.
    pub timeout: u32,
    pub token: String,
    ssh_host: Option<String>,
    /// The remote `$HOME`, when there is one.
    pub home: Option<String>,
}

impl Host {
    /// Resolve the host this install goes to. `ingress` is the shared hook script's
    /// source, which the remote cache path is derived from.
    pub async fn open(
        kind: &str,
        workspace: &QueueWorkspace,
        token: &str,
        ingress: &str,
    ) -> AppResult<Host> {
        let Some(harness) = registry::find(kind) else {
            return Err(AppError::machine("HARNESS_UNSUPPORTED"));
        };
        let mut root = plugin_root(kind);
        let mut node = which::which("node")
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|_| "node".into());
        let mut ssh_host = None;
        let mut home = None;
        if workspace.kind == "ssh" {
            let host = workspace
                .ssh_host
                .as_deref()
                .ok_or_else(|| AppError::msg("工作区不存在"))?
                .to_string();
            let remote_home =
                String::from_utf8_lossy(&ssh_exec(&host, r#"printf "%s" "$HOME""#).await?)
                    .trim()
                    .to_string();
            if !remote_home.starts_with('/') {
                return Err(AppError::machine("REMOTE_HOME_UNKNOWN"));
            }
            let digest = hex::encode(&Sha256::digest(ingress.as_bytes())[..8]);
            root = PathBuf::from(harness.remote_root(&remote_home, token, &digest));
            // `command -v node` exits non-zero when node is absent, and a non-zero exit
            // would surface the login shell's rc noise (ioctl complaints from a
            // pty-less shell) as the error text. The `true` keeps the probe alive, so
            // an empty answer reaches the friendly check below.
            node = String::from_utf8_lossy(&ssh_login_exec(&host, "command -v node; true").await?)
                .trim()
                .to_string();
            if !node.starts_with('/') {
                return Err(AppError::machine("HARNESS_NODE_MISSING"));
            }
            ssh_host = Some(host);
            home = Some(remote_home);
        }
        let hook_path = if workspace.kind == "ssh" {
            format!("{}/hook.cjs", root.display())
        } else {
            root.join("hook.cjs").to_string_lossy().into_owned()
        };
        let windows = workspace.kind == "local" && cfg!(windows);
        let timeout = harness.hook_timeout(windows);
        Ok(Host {
            kind: kind.into(),
            harness,
            remote: workspace.kind == "ssh",
            windows,
            root,
            hook_path,
            node,
            timeout,
            token: token.into(),
            ssh_host,
            home,
        })
    }

    pub(super) fn host_name(&self) -> AppResult<&str> {
        self.ssh_host
            .as_deref()
            .ok_or_else(|| AppError::machine("WORKSPACE_MISSING"))
    }

    pub(super) fn quote(&self, value: &str) -> String {
        if self.windows {
            format!("\"{}\"", value.replace('"', "\\\""))
        } else {
            shell_quote(value)
        }
    }

    /// `node <hook> <event>`, spelled for this host's shell — the harness's own
    /// invocation, with no per-kind spelling of its own.
    pub fn command(&self, event: Option<&str>) -> String {
        self.harness.hook_command(self, event)
    }

    /// The generic invocation every harness without a spelling of its own uses.
    pub fn generic_hook_command(&self, event: Option<&str>) -> String {
        self.generic_hook_command_with_prefix(event, "")
    }

    /// The generic invocation, with a kind baked into the command line so foreign
    /// sessions still answer the reply the CLI waits for. The prefix is a unix shell
    /// env-prefix; Windows ingress identifies the kind from its installed directory.
    pub fn generic_hook_command_with_prefix(&self, event: Option<&str>, prefix: &str) -> String {
        if self.windows {
            return super::windows::windows_hook_command(&self.node, &self.hook_path, event);
        }
        format!(
            "{prefix}{}{}",
            [self.node.as_str(), self.hook_path.as_str()]
                .into_iter()
                .map(|value| self.quote(value))
                .collect::<Vec<_>>()
                .join(" "),
            event
                .map(|event| format!(" {}", self.quote(event)))
                .unwrap_or_default()
        )
    }

    /// Absolute path of one of this harness's own files, spelled for the host.
    pub fn relative(&self, name: &str) -> String {
        if self.remote {
            format!("{}/{}", self.root.display(), name)
        } else {
            self.root.join(name).to_string_lossy().into_owned()
        }
    }

    /// Put the plugin's files in place, then update the config files it shares with the
    /// CLI's own settings.
    pub async fn install(&self, plan: &Plan) -> AppResult<()> {
        if self.remote {
            let host = self.host_name()?;
            let payload = base64::Engine::encode(
                &base64::engine::general_purpose::STANDARD,
                serde_json::to_string(&plan.files)?,
            );
            ssh_exec(
                host,
                &[
                    shell_quote(&self.node),
                    "-e".into(),
                    shell_quote(PUSH),
                    shell_quote(&self.root.to_string_lossy()),
                    shell_quote(&payload),
                ]
                .join(" "),
            )
            .await?;
            for merge in &plan.user_config {
                if let Some((script, args)) = &merge.remote {
                    let payload = self.relative(merge.payload);
                    let mut argv = vec![
                        shell_quote(&self.node),
                        "-e".to_string(),
                        shell_quote(script),
                    ];
                    argv.extend(
                        args(self, &merge.path, &payload)
                            .into_iter()
                            .map(|value| shell_quote(&value)),
                    );
                    ssh_exec(host, &argv.join(" ")).await?;
                }
            }
            return Ok(());
        }
        for (name, body) in &plan.files {
            let path = self.root.join(name);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            atomic_write(&path, body)?;
        }
        for merge in &plan.user_config {
            let existing = std::fs::read_to_string(&merge.path).ok();
            let payload = plan
                .files
                .get(merge.payload)
                .map(String::as_str)
                .unwrap_or_default();
            let text = (merge.local)(existing.as_deref(), payload, self)?;
            if let Some(parent) = Path::new(&merge.path).parent() {
                std::fs::create_dir_all(parent)?;
            }
            atomic_write(Path::new(&merge.path), &text)?;
        }
        Ok(())
    }

    /// What every card's CLI needs in order to report back.
    pub fn base_env(&self, directory: &Path) -> HashMap<String, String> {
        let mut env = HashMap::new();
        if self.remote {
            env.insert("QUE_HARNESS_CHANNEL".into(), self.token.clone());
            if let Some(signal_dir) = self.harness.remote_signal_dir(self) {
                env.insert("QUE_HARNESS_SIGNAL_DIR".into(), signal_dir);
            }
        } else {
            env.insert(
                "QUE_HARNESS_SIGNAL_DIR".into(),
                directory.to_string_lossy().into_owned(),
            );
        }
        env.insert("QUE_HARNESS_KIND".into(), self.kind.clone());
        // Fire the hook's internal watchdog before the runner's kill deadline.
        env.insert(
            "QUE_HARNESS_WATCHDOG_MS".into(),
            ((self.timeout - 2).max(1) * 1000).to_string(),
        );
        if crate::debuglog::verbose() {
            env.insert("QUE_HARNESS_DEBUG".into(), "1".into());
        }
        env
    }
}

/// The machine-wide install: the user-level config that serves every session Que did not
/// launch. There is no token and no per-card signal dir here — the ingress falls back to
/// the external sink on its own.
pub struct GlobalCtx {
    /// Where the per-kind plugin directories live.
    pub plugins: PathBuf,
    pub node: String,
    pub home: PathBuf,
    bin_dir: PathBuf,
}

impl GlobalCtx {
    pub fn new(bin_dir: &Path, plugins: &Path) -> GlobalCtx {
        GlobalCtx {
            plugins: plugins.to_path_buf(),
            node: which::which("node")
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_else(|_| "node".into()),
            home: crate::paths::user_home().unwrap_or_else(|| PathBuf::from(".")),
            bin_dir: bin_dir.to_path_buf(),
        }
    }

    /// Where this harness's ingress script will live, as the CLI is told to call it.
    pub fn hook_path(&self, kind: &str) -> String {
        self.plugins
            .join(kind)
            .join("hook.cjs")
            .to_string_lossy()
            .into_owned()
    }

    /// Lay the shared ingress script down under a harness's plugin directory.
    pub fn install_ingress(&self, kind: &str) -> AppResult<()> {
        self.install_file("harness-hook.cjs", kind, "hook.cjs")
    }

    /// Same, for a harness whose plugin is a single file of its own.
    pub fn install_plugin(&self, kind: &str, source: &str, target: &str) -> AppResult<()> {
        self.install_file(source, kind, target)
    }

    fn install_file(&self, source: &str, kind: &str, target: &str) -> AppResult<()> {
        let body = std::fs::read_to_string(self.bin_dir.join(source))?;
        let dir = self.plugins.join(kind);
        std::fs::create_dir_all(&dir)?;
        atomic_write(&dir.join(target), &body)?;
        Ok(())
    }
}
