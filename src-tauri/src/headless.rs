//! Opt-in test binary: same API/PTY/hook/queue runtime, no desktop window.
use std::path::PathBuf;

pub fn run() -> Result<(), Box<dyn std::error::Error>> {
    let root = PathBuf::from(
        std::env::args_os()
            .nth(1)
            .ok_or("Usage: que-headless EMPTY_PROFILE_DIR")?,
    );
    std::fs::create_dir_all(&root)?;
    // Keep ordinary drive paths for child CLI file URLs (canonicalize adds a
    // Windows verbatim prefix which some extension loaders do not accept).
    let root = std::path::absolute(root)?;
    if root.read_dir()?.next().is_some() {
        return Err("Headless profile must be empty".into());
    }
    let home = root.join("home");
    std::fs::create_dir(&home)?;
    crate::paths::set_test_home(home.clone());
    // Windows Known Folder APIs ignore HOME/USERPROFILE. Que uses the scoped
    // override above; child CLIs receive their own supported config overrides.
    for (name, path) in [
        ("HOME", home.clone()),
        ("USERPROFILE", home.clone()),
        ("QUE_DATA_DIR", root.join("que")),
        ("CODEX_HOME", home.join(".codex")),
        ("CLAUDE_CONFIG_DIR", home.join(".claude")),
        ("CODEBUDDY_CONFIG_DIR", home.join(".codebuddy")),
        ("GROK_HOME", home.join(".grok")),
        ("XDG_CONFIG_HOME", home.join(".config")),
        ("XDG_DATA_HOME", home.join(".local/share")),
        ("XDG_STATE_HOME", home.join(".local/state")),
    ] {
        std::env::set_var(name, path);
    }
    for name in [
        "QUE_QUEUE_FILE",
        "QUE_REMOTE_HOSTS",
        "QUE_EXTERNAL_SIGNAL_DIR",
        "QUE_HARNESS_KIND",
        "QUE_HARNESS_SIGNAL_DIR",
        "QUE_HARNESS_CHANNEL",
        "PI_CODING_AGENT_DIR",
        "PI_HOME",
        "OMP_PROFILE",
    ] {
        std::env::remove_var(name);
    }
    let runtime = tokio::runtime::Runtime::new()?;
    runtime.block_on(async {
        crate::debuglog::init();
        crate::conpty::preload(None);
        let state = crate::api::build_state(None);
        let terminals = state.terminals.clone();
        let port = crate::api::start_server(state).await?;
        println!("{}", serde_json::json!({"base":format!("http://127.0.0.1:{port}"),"profile":root,"home":home}));
        // The parent owns stdin. EOF cleanly stops only this test instance.
        tokio::task::spawn_blocking(|| { use std::io::Read; let _ = std::io::stdin().read_to_end(&mut Vec::new()); }).await.ok();
        terminals.shutdown();
        Ok::<(), Box<dyn std::error::Error>>(())
    })
}
