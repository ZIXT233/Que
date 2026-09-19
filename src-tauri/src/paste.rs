use crate::error::{AppError, AppResult};
use crate::paths::data_dir;
use crate::ssh::{shell_quote, ssh_exec, ssh_exec_stdin};
use base64::Engine;
use serde_json::Value;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};

const MAX_ATTACHED_IMAGE_BYTES: usize = 10 * 1024 * 1024;
const MAX_ATTACHED_IMAGES: usize = 10;
const MAX_DROP_FILES: usize = 50;
const MAX_DROP_FILE_BYTES: usize = 25 * 1024 * 1024;
const MAX_DROP_TOTAL_BYTES: usize = 100 * 1024 * 1024;

#[derive(Clone)]
pub struct RemoteWorkspace {
    pub ssh_host: String,
}

pub fn load_ssh_workspace(cwd: &str) -> AppResult<Option<RemoteWorkspace>> {
    let root = data_dir().join("ssh");
    let cwd_path = PathBuf::from(cwd);
    if !cwd_path.starts_with(&root) {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(cwd_path.join("remote-workspace.json"))
        .map_err(|error| AppError::msg(format!("SSH 工作区配置不可读：{error}")))?;
    let value: Value = serde_json::from_str(&raw)?;
    let ssh_host = value
        .get("sshHost")
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::msg("SSH 工作区配置不可读：missing sshHost"))?;
    Ok(Some(RemoteWorkspace {
        ssh_host: ssh_host.to_string(),
    }))
}

pub fn terminal_image_extension(data: &[u8]) -> AppResult<&'static str> {
    if data.len() >= 8 && data[..8] == [137, 80, 78, 71, 13, 10, 26, 10] {
        return Ok("png");
    }
    if data.len() >= 3 && data[0] == 255 && data[1] == 216 && data[2] == 255 {
        return Ok("jpg");
    }
    if data.len() >= 6 && (data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a")) {
        return Ok("gif");
    }
    if data.len() >= 12 && data.starts_with(b"RIFF") && &data[8..12] == b"WEBP" {
        return Ok("webp");
    }
    Err(AppError::msg(
        "Unsupported image. Paste a PNG, JPEG, GIF or WebP image.",
    ))
}

fn base64_decoded_len(data: &str) -> Option<usize> {
    if data.is_empty() || data.len() % 4 != 0 {
        return None;
    }
    let padding = if data.ends_with("==") {
        2
    } else if data.ends_with('=') {
        1
    } else {
        0
    };
    let end = data.len() - padding;
    if !data[..end]
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/')
    {
        return None;
    }
    if !data[end..].bytes().all(|b| b == b'=') {
        return None;
    }
    Some((data.len() / 4) * 3 - padding)
}

pub fn validate_terminal_images(images: &Value) -> Option<String> {
    let Some(items) = images.as_array() else {
        return Some("images must be an array".into());
    };
    if items.is_empty() {
        return Some("No images to paste".into());
    }
    if items.len() > MAX_ATTACHED_IMAGES {
        return Some(format!(
            "A message can include at most {MAX_ATTACHED_IMAGES} images"
        ));
    }
    for image in items {
        if image.get("type").and_then(|v| v.as_str()) != Some("image") {
            return Some("Each attachment must be an image".into());
        }
        let Some(data) = image.get("data").and_then(|v| v.as_str()) else {
            return Some(format!(
                "Each image must be valid base64 image data of {}MB or smaller",
                MAX_ATTACHED_IMAGE_BYTES / (1024 * 1024)
            ));
        };
        let mime = image.get("mimeType").and_then(|v| v.as_str()).unwrap_or("");
        let bytes = base64_decoded_len(data);
        if !mime.starts_with("image/") || !bytes.is_some_and(|n| n <= MAX_ATTACHED_IMAGE_BYTES) {
            return Some(format!(
                "Each image must be valid base64 image data of {}MB or smaller",
                MAX_ATTACHED_IMAGE_BYTES / (1024 * 1024)
            ));
        }
        if let Ok(decoded) = base64::engine::general_purpose::STANDARD.decode(data) {
            if terminal_image_extension(&decoded).is_err() {
                return Some("Unsupported image. Paste a PNG, JPEG, GIF or WebP image.".into());
            }
        } else {
            return Some(format!(
                "Each image must be valid base64 image data of {}MB or smaller",
                MAX_ATTACHED_IMAGE_BYTES / (1024 * 1024)
            ));
        }
    }
    None
}

pub fn validate_terminal_files(files: &[(String, Vec<u8>)]) -> Option<String> {
    if files.is_empty() {
        return Some("No files selected".into());
    }
    if files.len() > MAX_DROP_FILES
        || files
            .iter()
            .any(|(_, body)| body.len() > MAX_DROP_FILE_BYTES)
        || files.iter().map(|(_, body)| body.len()).sum::<usize>() > MAX_DROP_TOTAL_BYTES
    {
        return Some("files.dropLimits".into());
    }
    let mut seen = std::collections::HashSet::new();
    for (name, _) in files {
        if name.is_empty() || name == "." || name == ".." || name.contains('\0') {
            return Some(format!(
                "Invalid file name: {}",
                if name.is_empty() { "(empty)" } else { name }
            ));
        }
        if name.contains('/')
            || name.contains('\\')
            || Path::new(name).file_name().and_then(|s| s.to_str()) != Some(name)
        {
            return Some(format!("File names must not contain a path: {name}"));
        }
        if name.chars().any(|c| c.is_control()) {
            return Some("Invalid control character in filename".into());
        }
        if !seen.insert(name) {
            return Some(format!("Duplicate file name in upload: {name}"));
        }
    }
    None
}

fn write_exclusive(path: &Path, bytes: &[u8]) -> AppResult<()> {
    let mut opts = OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    opts.open(path)?.write_all(bytes)?;
    Ok(())
}

pub async fn save_terminal_images(cwd: &str, images: &[Value]) -> AppResult<Vec<String>> {
    let remote = load_ssh_workspace(cwd)?;
    let directory = if let Some(remote) = &remote {
        let dir = String::from_utf8_lossy(
            &ssh_exec(
                &remote.ssh_host,
                "umask 077; mktemp -d /tmp/que-images-XXXXXXXX",
            )
            .await?,
        )
        .trim()
        .to_string();
        if !dir.starts_with('/') && !cfg!(windows) {
            return Err(AppError::msg("Invalid image directory"));
        }
        dir
    } else {
        tempfile::Builder::new()
            .prefix("que-images-")
            .tempdir()
            .map_err(|e| AppError::msg(e.to_string()))?
            .keep()
            .to_string_lossy()
            .into_owned()
    };
    let mut paths = Vec::new();
    for image in images {
        let data = image.get("data").and_then(|v| v.as_str()).unwrap_or("");
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data)
            .map_err(|e| AppError::msg(e.to_string()))?;
        let name = format!(
            "{}.{}",
            uuid::Uuid::new_v4(),
            terminal_image_extension(&bytes)?
        );
        if let Some(remote) = &remote {
            let path = format!("{directory}/{name}");
            ssh_exec_stdin(
                &remote.ssh_host,
                &format!("umask 077; cat > {}", shell_quote(&path)),
                &bytes,
            )
            .await?;
            paths.push(path);
        } else {
            let path = PathBuf::from(&directory).join(&name);
            write_exclusive(&path, &bytes)?;
            paths.push(path.to_string_lossy().into_owned());
        }
    }
    Ok(paths)
}

pub async fn save_terminal_files(cwd: &str, files: &[(String, Vec<u8>)]) -> AppResult<Vec<String>> {
    let remote = load_ssh_workspace(cwd)?;
    let directory = if let Some(remote) = &remote {
        let dir = String::from_utf8_lossy(
            &ssh_exec(
                &remote.ssh_host,
                "umask 077; mktemp -d /tmp/que-files-XXXXXXXX",
            )
            .await?,
        )
        .trim()
        .to_string();
        if !regex::Regex::new(r"^/tmp/que-files-[a-zA-Z0-9]+$")
            .unwrap()
            .is_match(&dir)
        {
            return Err(AppError::msg("Invalid remote upload directory"));
        }
        dir
    } else {
        tempfile::Builder::new()
            .prefix("que-files-")
            .tempdir()
            .map_err(|e| AppError::msg(e.to_string()))?
            .keep()
            .to_string_lossy()
            .into_owned()
    };
    let result = save_files_inner(remote.as_ref(), &directory, files).await;
    if result.is_err() {
        if let Some(remote) = &remote {
            let _ = ssh_exec(
                &remote.ssh_host,
                &format!("rm -rf -- {}", shell_quote(&directory)),
            )
            .await;
        } else {
            let _ = std::fs::remove_dir_all(&directory);
        }
    }
    result
}

async fn save_files_inner(
    remote: Option<&RemoteWorkspace>,
    directory: &str,
    files: &[(String, Vec<u8>)],
) -> AppResult<Vec<String>> {
    let mut paths = Vec::new();
    for (name, bytes) in files {
        if let Some(remote) = remote {
            let path = format!("{directory}/{name}");
            ssh_exec_stdin(
                &remote.ssh_host,
                &format!("umask 077; cat > {}", shell_quote(&path)),
                bytes,
            )
            .await?;
            paths.push(path);
        } else {
            let path = PathBuf::from(directory).join(name);
            write_exclusive(&path, bytes)?;
            paths.push(path.to_string_lossy().into_owned());
        }
    }
    Ok(paths)
}

pub fn terminal_image_paste(paths: &[String], bracketed: bool) -> String {
    let text = paths
        .iter()
        .map(|path| {
            if path.chars().any(|c| {
                matches!(
                    c,
                    ' ' | '\t'
                        | '\n'
                        | '\r'
                        | '\''
                        | '"'
                        | '`'
                        | '$'
                        | ';'
                        | '&'
                        | '|'
                        | '<'
                        | '>'
                        | '('
                        | ')'
                        | '['
                        | ']'
                        | '{'
                        | '}'
                        | '!'
                        | '*'
                        | '?'
                        | '\\'
                )
            }) {
                if cfg!(windows) {
                    format!("\"{}\"", path.replace('"', "\"\""))
                } else {
                    shell_quote(path)
                }
            } else {
                path.clone()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
        + " ";
    if bracketed {
        format!("\x1b[200~{text}\x1b[201~")
    } else {
        text
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_png_and_rejects_unknown() {
        let mut png = vec![137, 80, 78, 71, 13, 10, 26, 10];
        png.extend_from_slice(&[0; 8]);
        assert_eq!(terminal_image_extension(&png).unwrap(), "png");
        assert!(terminal_image_extension(b"not-an-image").is_err());
    }

    #[test]
    fn paste_quotes_special_paths() {
        let text = terminal_image_paste(&["/tmp/a b.png".into()], false);
        assert!(text.contains("'") || text.contains("\""));
        assert!(text.ends_with(' '));
    }
}
