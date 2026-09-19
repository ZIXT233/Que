//! Whatever the CLI already had in the config file Que has to write into.
//!
//! Only the two harnesses whose config is *replaced* rather than extended share this:
//! Gemini's defaults file and OpenCode's config env. Every harness-private guard or
//! merge lives with the harness that needs it, under `kinds/`.

use crate::error::{AppError, AppResult};
use crate::models::QueueWorkspace;
use crate::ssh::{shell_quote, ssh_exec};
use serde_json::{Map, Value};
use std::path::PathBuf;

pub async fn inherited_config(
    kind: &str,
    workspace: &QueueWorkspace,
    node: &str,
) -> AppResult<Map<String, Value>> {
    let text = if workspace.kind == "ssh" {
        let host = workspace
            .ssh_host
            .as_deref()
            .ok_or_else(|| AppError::machine("WORKSPACE_MISSING"))?;
        let script = if kind == "opencode-cli" {
            r#"const fs=require('node:fs'),p=require('node:path');const root=process.env.XDG_CONFIG_HOME||p.join(process.env.HOME||process.env.USERPROFILE,'.config');const f=p.join(root,'opencode','cli.json');let cfg={};try{cfg=JSON.parse(fs.readFileSync(f,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}Object.assign(cfg,JSON.parse(process.env.OPENCODE_CLI_CONFIG_CONTENT||'{}'));process.stdout.write(JSON.stringify(cfg));"#
        } else if kind == "opencode" {
            r#"process.stdout.write(process.env.OPENCODE_CONFIG_CONTENT||"{}");"#
        } else {
            r#"const fs=require("node:fs"),p=require("node:path");const f=process.env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH||(process.platform==="darwin"?"/Library/Application Support/GeminiCli/system-defaults.json":"/etc/gemini-cli/system-defaults.json");try{process.stdout.write(fs.readFileSync(f,"utf8"));}catch(e){if(e.code!=="ENOENT")throw e;process.stdout.write("{}");}"#
        };
        String::from_utf8_lossy(
            &ssh_exec(
                host,
                &[shell_quote(node), "-e".into(), shell_quote(script)].join(" "),
            )
            .await?,
        )
        .into_owned()
    } else if kind == "opencode-cli" {
        let root = std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                crate::paths::user_home()
                    .unwrap_or_default()
                    .join(".config")
            });
        let mut config: Map<String, Value> =
            match std::fs::read_to_string(root.join("opencode/cli.json")) {
                Ok(text) => serde_json::from_str(&text)?,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Map::new(),
                Err(error) => return Err(error.into()),
            };
        let overlay: Map<String, Value> = serde_json::from_str(
            &std::env::var("OPENCODE_CLI_CONFIG_CONTENT").unwrap_or_else(|_| "{}".into()),
        )?;
        config.extend(overlay);
        serde_json::to_string(&config)?
    } else if kind == "opencode" {
        std::env::var("OPENCODE_CONFIG_CONTENT").unwrap_or_else(|_| "{}".into())
    } else {
        match std::fs::read_to_string(gemini_defaults_path()) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => "{}".into(),
            Err(error) => return Err(error.into()),
        }
    };
    let text = text.trim().if_empty("{}");
    let config: Value = serde_json::from_str(&text)?;
    match config {
        Value::Object(map) => Ok(map),
        _ => Err(AppError::machine("HARNESS_CONFIG_UNREADABLE")),
    }
}

fn gemini_defaults_path() -> PathBuf {
    if let Ok(path) = std::env::var("GEMINI_CLI_SYSTEM_DEFAULTS_PATH") {
        return PathBuf::from(path);
    }
    if cfg!(target_os = "macos") {
        PathBuf::from("/Library/Application Support/GeminiCli/system-defaults.json")
    } else if cfg!(windows) {
        PathBuf::from(std::env::var("ProgramData").unwrap_or_else(|_| r"C:\ProgramData".into()))
            .join("gemini-cli")
            .join("system-defaults.json")
    } else {
        PathBuf::from("/etc/gemini-cli/system-defaults.json")
    }
}

trait IfEmpty {
    fn if_empty(self, fallback: &str) -> String;
}

impl IfEmpty for &str {
    fn if_empty(self, fallback: &str) -> String {
        if self.is_empty() {
            fallback.to_string()
        } else {
            self.to_string()
        }
    }
}
