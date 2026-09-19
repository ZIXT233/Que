fn main() {
    println!("cargo:rerun-if-changed=hook-runtime/src");
    println!("cargo:rerun-if-changed=hook-runtime/Cargo.toml");
    println!("cargo:rerun-if-changed=hook-runtime/Cargo.lock");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        let out = std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap());
        let target = std::env::var("TARGET").unwrap();
        // A separate target directory avoids the parent Cargo build's lock.
        let mut command = std::process::Command::new(std::env::var_os("CARGO").unwrap());
        command
            .args([
                "build",
                "--locked",
                "--release",
                "--manifest-path",
                "hook-runtime/Cargo.toml",
                "--target",
                &target,
                "--target-dir",
            ])
            .arg(out.join("hook-runtime"));
        assert!(
            command.status().expect("build Que hook runtime").success(),
            "Que hook runtime compilation failed"
        );
        std::fs::copy(
            out.join("hook-runtime")
                .join(target)
                .join("release/que-hook.exe"),
            out.join("que-hook.exe"),
        )
        .expect("embed Que hook runtime");
    }
    tauri_build::build()
}
