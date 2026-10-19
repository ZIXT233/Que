use std::process::Command;

/// The commit this build comes from, shown beside the version (QUE_COMMIT, set by
/// the build environment, or the checkout's HEAD): the version number alone does not
/// tell two builds apart.
fn main() {
    let git = |args: &[&str]| {
        Command::new("git").args(args).output().ok()
            .filter(|out| out.status.success())
            .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
    };
    let commit = std::env::var("QUE_COMMIT").ok().filter(|c| !c.is_empty())
        .or_else(|| git(&["rev-parse", "--short=7", "HEAD"]))
        .unwrap_or_else(|| "unknown".into());
    println!("cargo:rustc-env=QUE_COMMIT={commit}");
    println!("cargo:rerun-if-env-changed=QUE_COMMIT");
    for path in ["HEAD", "refs/heads"] {
        if let Some(path) = git(&["rev-parse", "--git-path", path]) { println!("cargo:rerun-if-changed={path}"); }
    }
    tauri_build::build()
}
