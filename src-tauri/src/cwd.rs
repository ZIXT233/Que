use crate::error::{AppError, AppResult};
use crate::paths::expand_user;
use crate::winproc::NoWindow;
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowseResponse {
    pub path: String,
    pub parent_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub drives: Option<Vec<Drive>>,
    pub directories: Vec<DirectoryEntry>,
}

#[derive(Serialize)]
pub struct Drive {
    pub name: String,
    pub path: String,
}

#[derive(Serialize)]
pub struct DirectoryEntry {
    pub name: String,
    pub path: String,
}

pub fn browse(requested: Option<String>) -> AppResult<BrowseResponse> {
    #[cfg(windows)]
    if requested.as_deref().is_none_or(|s| s.is_empty()) {
        return Ok(BrowseResponse {
            path: String::new(),
            parent_path: None,
            drives: Some(windows_drives()),
            directories: vec![],
        });
    }

    let start = requested
        .filter(|s| !s.trim().is_empty())
        .map(|s| expand_user(&s))
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")));
    if !start.is_dir() {
        return Err(AppError::msg("Directory does not exist"));
    }
    let resolved = crate::paths::ordinary_windows_path(start.canonicalize().unwrap_or(start));
    Ok(BrowseResponse {
        path: resolved.to_string_lossy().into_owned(),
        parent_path: resolved.parent().map(|p| p.to_string_lossy().into_owned()),
        drives: None,
        directories: list_directories(&resolved)?,
    })
}

fn list_directories(path: &Path) -> AppResult<Vec<DirectoryEntry>> {
    let mut entries = Vec::new();
    let read = std::fs::read_dir(path)?;
    for entry in read.flatten() {
        let file_type = entry.file_type().ok();
        if file_type.is_some_and(|t| t.is_dir()) {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            entries.push(DirectoryEntry {
                path: entry.path().to_string_lossy().into_owned(),
                name,
            });
        }
    }
    entries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(entries)
}

#[cfg(windows)]
fn windows_drives() -> Vec<Drive> {
    (b'A'..=b'Z')
        .filter_map(|letter| {
            let path = format!("{}:\\", letter as char);
            if Path::new(&path).is_dir() {
                Some(Drive {
                    name: path.clone(),
                    path,
                })
            } else {
                None
            }
        })
        .collect()
}

pub async fn pick_local_folder(locale: Option<String>) -> AppResult<Option<String>> {
    let title = match locale.as_deref() {
        Some("zh-CN") => "选择工作区目录",
        Some("zh-TW") => "選擇工作區目錄",
        _ => "Choose workspace folder",
    };
    let output = if cfg!(target_os = "macos") {
        tokio::process::Command::new("osascript")
            .args([
                "-e",
                &format!("POSIX path of (choose folder with prompt \"{title}\")"),
            ])
            .output()
            .await
    } else if cfg!(windows) {
        tokio::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-STA", "-Command", "Add-Type -AssemblyName System.Windows.Forms; $dialog = New-Object System.Windows.Forms.FolderBrowserDialog; if ($dialog.ShowDialog() -eq \"OK\") { [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($dialog.SelectedPath)) }"])
            .no_window()
            .output()
            .await
    } else {
        tokio::process::Command::new("zenity")
            .args([
                "--file-selection",
                "--directory",
                &format!("--title={title}"),
            ])
            .output()
            .await
    };
    match output {
        Ok(result) if result.status.success() => {
            let cwd = if cfg!(windows) {
                // Windows PowerShell may encode redirected stdout using the active
                // console code page. Only ASCII base64 crosses that boundary.
                let encoded = String::from_utf8(result.stdout)
                    .map_err(|_| AppError::machine("LOCAL_PICKER"))?;
                if encoded.trim().is_empty() {
                    return Ok(None);
                }
                let bytes = base64::Engine::decode(
                    &base64::engine::general_purpose::STANDARD,
                    encoded.trim(),
                )
                .map_err(|_| AppError::machine("LOCAL_PICKER"))?;
                String::from_utf8(bytes).map_err(|_| AppError::machine("LOCAL_PICKER"))?
            } else {
                String::from_utf8_lossy(&result.stdout).trim().to_string()
            };
            Ok(if cwd.is_empty() { None } else { Some(cwd) })
        }
        Ok(_) => Ok(None),
        Err(_) => Err(AppError::machine("LOCAL_PICKER")),
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::browse;

    #[test]
    fn browsing_chinese_directory_returns_ordinary_paths() {
        let root = tempfile::tempdir().unwrap();
        let folder = root.path().join("中文目录");
        std::fs::create_dir(&folder).unwrap();
        let result = browse(Some(folder.to_string_lossy().into_owned())).unwrap();
        assert_eq!(result.path, folder.to_string_lossy());
        assert_eq!(result.parent_path.as_deref(), root.path().to_str());
        assert!(!result.path.starts_with(r"\\?\"));
    }
}
