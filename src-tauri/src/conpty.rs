//! Windows: sideload the bundled modern ConPTY.
//!
//! Source: Microsoft.Windows.Console.ConPTY.1.24.260710001 nupkg, taken from
//! microsoft/terminal release v1.24.11911.0 (MIT). Both files are
//! Authenticode-signed by Microsoft Corporation; see
//! resources/conpty/PROVENANCE.md.
//!
//! The inbox ConPTY (kernel32 exports) is frozen with the Windows release
//! cycle and carries a decade of known bugs (OSC > 256 chars dropped on
//! Win10, DCS never flushed, 4 KB response corruption, no OSC 10/11/12/17
//! query forwarding). The nupkg build fixes those. portable-pty prefers a
//! sideloaded conpty.dll: it calls LoadLibraryW("conpty.dll"), and once our
//! module is loaded into the process by full path, that call resolves to the
//! sideloaded module instead of the inbox kernel32 build. conpty.dll then
//! locates OpenConsole.exe in its own directory, so both files must stay
//! side by side.

use std::path::Path;

/// The bundled engine supports modern reflow independently of the OS build.
/// For the inbox engine report the actual OS version, never a guessed build.
pub fn host_build_number() -> Option<u32> {
    #[cfg(windows)]
    {
        #[repr(C)]
        struct Version {
            size: u32,
            major: u32,
            minor: u32,
            build: u32,
            platform: u32,
            service_pack: [u16; 128],
        }
        #[link(name = "ntdll")]
        extern "system" {
            fn RtlGetVersion(version: *mut Version) -> i32;
        }
        let mut version = Version {
            size: std::mem::size_of::<Version>() as u32,
            major: 0,
            minor: 0,
            build: 0,
            platform: 0,
            service_pack: [0; 128],
        };
        if unsafe { RtlGetVersion(&mut version) } == 0 {
            return Some(version.build);
        }
    }
    None
}

/// Bundled ConPTY dir name for the current target arch. The nupkg ships
/// per-arch binaries; an x64 conpty.dll cannot be loaded into an arm64
/// process (and vice versa), so the subdir must match the target.
#[cfg(windows)]
fn arch_dir() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "win-arm64",
        _ => "win-x64",
    }
}

#[cfg(windows)]
mod imp {
    use super::*;
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use std::path::PathBuf;
    use std::sync::OnceLock;

    static LOADED: OnceLock<bool> = OnceLock::new();

    /// True once the bundled conpty.dll is confirmed loaded into the process.
    /// Callers use this to gate behaviors that assume a modern ConPTY
    /// (e.g. color answers may follow the app theme instead of Campbell).
    pub fn sideloaded() -> bool {
        LOADED.get().copied() == Some(true)
    }

    /// Call once at startup with the Tauri resource dir. Idempotent.
    pub fn preload(resource_dir: Option<&Path>) {
        if let Some(dir) = resolve_dir(resource_dir) {
            let _ = LOADED.set(load_library(&dir));
        }
    }

    /// Fallback for when the startup preload missed (dev layouts). Cheap to
    /// call per spawn; retries only while no successful load was recorded.
    pub fn ensure_loaded() -> bool {
        if LOADED.get().copied() == Some(true) {
            return true;
        }
        let ok = resolve_dir(None).map(|d| load_library(&d)).unwrap_or(false);
        if ok {
            let _ = LOADED.set(true);
        }
        ok
    }

    fn load_library(dir: &Path) -> bool {
        let dll = dir.join("conpty.dll");
        if !dll.is_file() {
            return false;
        }
        let wide: Vec<u16> = OsStr::new(&dll)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let handle =
            unsafe { windows_sys::Win32::System::LibraryLoader::LoadLibraryW(wide.as_ptr()) };
        let ok = (handle as isize) != 0;
        crate::debuglog::info(
            "conpty",
            &format!(
                "sideload {} -> {}",
                dll.display(),
                if ok { "loaded" } else { "failed" }
            ),
        );
        ok
    }

    /// Search order mirrors paths::resolve_bin_dir: env override, bundled
    /// resource layouts, then dev-tree layouts relative to the cwd.
    fn resolve_dir(resource_dir: Option<&Path>) -> Option<PathBuf> {
        let mut candidates: Vec<PathBuf> = Vec::new();
        if let Ok(dir) = std::env::var("QUE_CONPTY_DIR") {
            candidates.push(PathBuf::from(dir));
        }
        if let Some(dir) = resource_dir {
            candidates.push(dir.join("resources").join("conpty").join(arch_dir()));
            candidates.push(dir.join("conpty").join(arch_dir()));
        }
        if let Ok(cwd) = std::env::current_dir() {
            candidates.push(cwd.join("resources").join("conpty").join(arch_dir()));
            candidates.push(
                cwd.join("src-tauri")
                    .join("resources")
                    .join("conpty")
                    .join(arch_dir()),
            );
        }
        candidates
            .into_iter()
            .find(|d| d.join("conpty.dll").is_file())
    }
}

#[cfg(windows)]
pub use imp::{ensure_loaded, preload, sideloaded};

#[cfg(not(windows))]
mod imp {
    use super::Path;

    /// No-op: unix ptys come from the kernel, nothing to sideload.
    pub fn preload(_resource_dir: Option<&Path>) {}
    /// Unix ptys are always "modern": every behavior gated on this is allowed.
    pub fn sideloaded() -> bool {
        true
    }
}

#[cfg(not(windows))]
pub use imp::{preload, sideloaded};

#[cfg(all(test, windows))]
mod tests {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use std::path::PathBuf;

    #[test]
    fn sideloads_the_bundled_conpty_dll() {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("conpty")
            .join(super::arch_dir());
        assert!(
            dir.join("conpty.dll").is_file(),
            "bundled conpty.dll missing"
        );
        assert!(
            dir.join("OpenConsole.exe").is_file(),
            "bundled OpenConsole.exe missing"
        );
        // Full end-to-end resolution: LoadLibraryW fails if the module or any
        // of its imports cannot be linked.
        let wide: Vec<u16> = OsStr::new(&dir.join("conpty.dll"))
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let handle =
            unsafe { windows_sys::Win32::System::LibraryLoader::LoadLibraryW(wide.as_ptr()) };
        assert!(
            (handle as isize) != 0,
            "LoadLibraryW failed for the bundled conpty.dll"
        );
    }
}
