//! OpenCode: an in-process plugin, named by an environment variable that carries the
//! whole config — including whatever the user already had.

use super::inherited::inherited_config;
use super::registry::{checked_id, Adapter, Ctx, GlobalCtx, Harness, Plan};
use crate::error::AppResult;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;

const GLOBAL_OWNER: &str = "que-opencode-external-v2";

/// OpenCode 2 uses its dedicated package. The former OpenCode v1 plugin
/// was injected through OPENCODE_CONFIG_CONTENT; leaving its copy behind
/// makes the v2 plugin screen report a failed, stale server plugin.
fn remove_legacy_v1(ctx: &GlobalCtx) {
    let legacy = ctx.plugins.join("opencode");
    for name in ["opencode-plugin.mjs", "hook.cjs"] {
        let _ = std::fs::remove_file(legacy.join(name));
    }
}

fn global_directory(ctx: &GlobalCtx) -> PathBuf {
    std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| ctx.home.join(".config"))
        .join("opencode/plugins/que-opencode-external-v2")
}

fn legacy_global_directory(ctx: &GlobalCtx) -> PathBuf {
    std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| ctx.home.join(".config"))
        .join("opencode/plugins/que-external-v2")
}

fn remove_owned_external_directory(dir: &std::path::Path) {
    if std::fs::read_to_string(dir.join(".que-owned"))
        .ok()
        .as_deref()
        == Some(GLOBAL_OWNER)
    {
        let _ = std::fs::remove_dir_all(dir);
    }
}

fn install_external_v2(ctx: &GlobalCtx) -> AppResult<()> {
    remove_owned_external_directory(&legacy_global_directory(ctx));
    let dir = global_directory(ctx);
    let marker = dir.join(".que-owned");
    if dir.exists() && std::fs::read_to_string(&marker).ok().as_deref() != Some(GLOBAL_OWNER) {
        return Err(crate::error::AppError::msg(
            "OpenCode 外部插件目录已被其他文件占用",
        ));
    }
    ctx.install_plugin("opencode", "harness-opencode-v2.mjs", "external-v2.mjs")?;
    let source = url::Url::from_file_path(ctx.plugins.join("opencode/external-v2.mjs"))
        .map_err(|_| crate::error::AppError::msg("OpenCode 外部插件路径无效"))?;
    let wrapper = format!(
        "import plugin from {};\nexport default {{ id: 'que.opencode.external.status', setup(ctx) {{\nif (process.env.QUE_HARNESS_SIGNAL_DIR || process.env.QUE_HARNESS_CHANNEL) return;\nreturn plugin.setup({{ ...ctx, options: {{ ...ctx.options, queExternalEnabledFile: {}, queExternalSignalDir: {} }} }});\n}} }};\n",
        serde_json::to_string(source.as_str())?, serde_json::to_string(&marker.to_string_lossy())?,
        serde_json::to_string(&crate::paths::external_signal_dir().to_string_lossy())?);
    crate::paths::atomic_write(&marker, GLOBAL_OWNER)?;
    crate::paths::atomic_write(&dir.join("tui.mjs"), &wrapper)?;
    // The discovery directory contains a CLI entrypoint and an inert server entrypoint.
    crate::paths::atomic_write(&dir.join("index.mjs"), "export default { id: 'que.opencode.external.status', setup() {}, async server() { return {}; } };\n")?;
    crate::paths::atomic_write(
        &dir.join("package.json"),
        r#"{"name":"que-opencode-external-v2","type":"module","exports":{".":"./index.mjs","./tui":"./tui.mjs"}}"#,
    )?;
    Ok(())
}

fn resume_args(session_id: &str) -> AppResult<Vec<String>> {
    Ok(vec!["--session".into(), checked_id(session_id)?.into()])
}

async fn plan(ctx: Ctx<'_>) -> AppResult<Plan> {
    let mut plan = Plan::default();
    let major = ctx
        .version
        .split(|c: char| !c.is_ascii_digit())
        .find(|s| !s.is_empty())
        .and_then(|s| s.parse::<u32>().ok())
        .ok_or_else(|| {
            crate::error::AppError::msg("无法识别 OpenCode 版本，无法安全选择插件 API")
        })?;
    if major >= 2 {
        plan.files.insert(
            "v2/package.json".into(),
            r#"{"name":"que-opencode-status","type":"module","exports":{"./tui":"./tui.mjs"}}"#
                .into(),
        );
        plan.files.insert(
            "v2/tui.mjs".into(),
            std::fs::read_to_string(ctx.bin_dir.join("harness-opencode-v2.mjs"))?,
        );
        let plugin = if ctx.host.remote {
            format!(
                "file://{}/v2",
                ctx.host
                    .root
                    .to_string_lossy()
                    .split('/')
                    .map(encoded)
                    .collect::<Vec<_>>()
                    .join("/")
            )
        } else {
            url::Url::from_directory_path(ctx.host.root.join("v2"))
                .map_err(|_| crate::error::AppError::msg("OpenCode 插件路径无效"))?
                .to_string()
        };
        let mut config = inherited_config("opencode-cli", ctx.workspace, &ctx.host.node).await?;
        let mut plugins = config
            .get("plugins")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        plugins.push(serde_json::Value::String(plugin));
        config.insert("plugins".into(), plugins.into());
        plan.env.insert(
            "OPENCODE_CLI_CONFIG_CONTENT".into(),
            serde_json::Value::Object(config).to_string(),
        );
        return Ok(plan);
    }
    plan.files.insert(
        "opencode-plugin.mjs".into(),
        std::fs::read_to_string(ctx.bin_dir.join("harness-opencode.mjs"))?,
    );
    let mut config = inherited_config("opencode", ctx.workspace, &ctx.host.node).await?;
    let plugin = if ctx.workspace.kind == "ssh" {
        format!(
            "file://{}/opencode-plugin.mjs",
            ctx.host
                .root
                .to_string_lossy()
                .split('/')
                .map(encoded)
                .collect::<Vec<_>>()
                .join("/")
        )
    } else {
        url::Url::from_file_path(ctx.host.root.join("opencode-plugin.mjs"))
            .map(|u| u.to_string())
            .unwrap_or_default()
    };
    let mut plugins = config
        .get("plugin")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    plugins.push(serde_json::Value::String(plugin));
    config.insert("plugin".into(), serde_json::Value::Array(plugins));
    plan.env.insert(
        "OPENCODE_CONFIG_CONTENT".into(),
        serde_json::Value::Object(config).to_string(),
    );
    Ok(plan)
}

fn encoded(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

pub struct OpenCode;

pub static OPENCODE: OpenCode = OpenCode;

impl Harness for OpenCode {
    fn id(&self) -> &'static str {
        "opencode"
    }
    fn adapter(&self) -> Option<Adapter> {
        Some(Adapter::new("opencode", &[], resume_args))
    }

    fn plan<'a>(
        &'a self,
        ctx: Ctx<'a>,
    ) -> Pin<Box<dyn Future<Output = AppResult<Plan>> + Send + 'a>> {
        Box::pin(plan(ctx))
    }

    /// OpenCode has no hook files: a session Que never launched only needs the plugin itself.
    fn global(&self, ctx: &GlobalCtx) {
        remove_legacy_v1(ctx);
        if let Err(error) = install_external_v2(ctx) {
            crate::debuglog::log_error("opencode external V2 plugin install", &error);
        }
    }
    /// Remove the plugin copy `global` laid down; the next card launch rewrites it.
    fn unglobal(&self, ctx: &GlobalCtx) {
        remove_legacy_v1(ctx);
        let _ = std::fs::remove_file(ctx.plugins.join("opencode").join("external-v2.mjs"));
        let dir = global_directory(ctx);
        remove_owned_external_directory(&dir);
        remove_owned_external_directory(&legacy_global_directory(ctx));
    }

    fn extra_search_dirs(&self) -> &'static [&'static str] {
        &[".opencode/bin"]
    }

    /// A session name arrives through the stable OSC title alone, so the session files
    /// have nothing to add.
    fn refresh_probe_label(&self) -> bool {
        false
    }

    fn external_ingress(&self) -> bool {
        true
    }
}
