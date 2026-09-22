//! Open the card's actual working directory in the user's external editor.
use crate::{api::AppState, hosts};
use tauri_plugin_opener::OpenerExt;
use url::Url;

fn remote_workspace_url(host: &str, workspace: &crate::models::QueueWorkspace) -> Result<String, String> {
    // Remote cards store the local runtime/cache directory in card.cwd.
    // The workspace owns the remote path, just as it does for harness launch.
    remote_url(host, &workspace.cwd)
}

fn remote_url(host: &str, cwd: &str) -> Result<String, String> {
    if host.is_empty() || host.starts_with('-') || !host.chars().all(|c| c.is_ascii_alphanumeric() || "._-@".contains(c)) {
        return Err("Invalid SSH host; use an alias from ~/.ssh/config".into());
    }
    if !cwd.starts_with('/') || cwd.chars().any(char::is_control) {
        return Err("Remote project directory must be an absolute Unix path".into());
    }
    let mut url = Url::parse("vscode://vscode-remote").unwrap();
    // Push path segments individually: #, ?, %, spaces and Unicode are data.
    url.path_segments_mut().unwrap().push(&format!("ssh-remote+{host}"))
        .extend(cwd[1..].split('/'));
    url.query_pairs_mut().append_pair("windowId", "_blank");
    Ok(url.into())
}

fn local_url(cwd: &str) -> Result<String, String> {
    let path = std::path::Path::new(cwd);
    if !path.is_absolute() || !path.is_dir() {
        return Err(format!("Project directory does not exist or is not absolute: {cwd}"));
    }
    let file = Url::from_directory_path(path).map_err(|_| "Invalid project directory")?;
    let mut url = Url::parse("vscode://file").unwrap();
    // Preserve a UNC server as part of the editor's file path.
    let encoded = match file.host_str() {
        Some(host) => format!("//{host}{}", file.path()),
        None => file.path().to_string(),
    };
    url.set_path(&encoded);
    url.query_pairs_mut().append_pair("windowId", "_blank");
    Ok(url.into())
}

#[tauri::command]
pub fn open_in_vscode(app: tauri::AppHandle, state: tauri::State<AppState>, card_id: String) -> Result<(), String> {
    let queue = state.queue.read_snapshot().map_err(|e| e.to_string())?;
    let card = queue.cards.iter().find(|c| c.id == card_id).ok_or("Card no longer exists")?;
    let workspace = match card.workspace_id.as_ref() {
        Some(id) => Some(queue.workspaces.as_ref().and_then(|items| items.iter().find(|w| &w.id == id))
            .ok_or("Workspace no longer exists")?),
        None => None,
    };
    let url = if let Some(workspace) = workspace.filter(|w| w.kind == "ssh") {
        let id = workspace.ssh_host.as_deref().filter(|h| !h.is_empty()).ok_or("SSH host is missing")?;
        let host = hosts::resolve(id).map_err(|e| e.to_string())?.ok_or("SSH host no longer exists")?;
        let target = if host.source == "config" {
            host.id
        } else {
            // Non-default ports and keys must be configured in VS Code's SSH config.
            // Do not silently connect to port 22 or edit the user's SSH configuration.
            if host.port.unwrap_or(22) != 22 || host.identity_file.is_some() {
                return Err("Add this host (including its port/key) to ~/.ssh/config, then use that SSH alias in Que to open it in VS Code".into());
            }
            match host.user.as_deref().filter(|u| !u.is_empty()) {
                Some(user) => format!("{user}@{}", host.hostname),
                None => host.hostname,
            }
        };
        remote_workspace_url(&target, workspace)?
    } else {
        local_url(&card.cwd)?
    };
    app.opener().open_url(url, None::<&str>)
        .map_err(|e| format!("Could not open VS Code. Install VS Code with its vscode:// URL handler enabled. {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_workspace_uses_remote_directory_not_local_runtime_cache() {
        let workspace: crate::models::QueueWorkspace = serde_json::from_value(serde_json::json!({
            "id": "remote-workspace",
            "name": "Remote",
            "kind": "ssh",
            "sshHost": "dev-alias",
            "cwd": "/home/zixt",
            "runtimeCwd": "C:\\Users\\ZIXT\\.que-dev\\ssh\\remote-workspace"
        })).unwrap();
        assert!(remote_url("dev-alias", &workspace.runtime_cwd).is_err());
        let value = remote_workspace_url("dev-alias", &workspace).unwrap();
        assert_eq!(Url::parse(&value).unwrap().path(), "/ssh-remote+dev-alias/home/zixt");
    }

    #[test]
    fn remote_path_cannot_inject_query_or_fragment() {
        let value = remote_url("dev-alias", "/home/me/中文 #?% repo").unwrap();
        let url = Url::parse(&value).unwrap();
        assert_eq!(url.host_str(), Some("vscode-remote"));
        assert!(url.path().starts_with("/ssh-remote+dev-alias/home/me/"));
        assert!(url.path().contains("%23%3F%25"));
        assert_eq!(url.query(), Some("windowId=_blank"));
        assert_eq!(url.fragment(), None);
        assert!(remote_url("-oProxyCommand=x", "/repo").is_err());
        assert!(remote_url("dev", "~/repo").is_err());
    }

    #[test]
    fn local_directory_is_checked_and_encoded() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("中文 # percent% folder");
        std::fs::create_dir(&path).unwrap();
        let value = local_url(path.to_str().unwrap()).unwrap();
        assert!(value.starts_with("vscode://file/"));
        assert!(value.contains("%23"));
        assert!(value.contains("percent%25"));
        assert!(!value.contains("%2525"));
        assert_eq!(Url::parse(&value).unwrap().fragment(), None);
        assert!(local_url(root.path().join("missing").to_str().unwrap()).is_err());
        assert!(local_url(".").is_err());
    }
}
