use crate::error::{AppError, AppResult};
use crate::models::RemoteHost;
use crate::paths::{atomic_write, remote_host_visibility_file, remote_hosts_file};
use crate::ssh::is_connected;
use regex::Regex;
use std::collections::HashSet;
use std::path::PathBuf;
use tokio::sync::Mutex;

pub struct HostStore {
    lock: Mutex<()>,
}

impl HostStore {
    pub fn new() -> Self {
        Self {
            lock: Mutex::new(()),
        }
    }

    pub async fn list(&self) -> AppResult<Vec<RemoteHost>> {
        let configured = config_hosts()?;
        let hidden = hidden_config_hosts()?;
        let saved = saved_hosts()?;
        let mut hosts = Vec::new();
        for mut host in configured {
            host.visible = Some(!hidden.contains(&host.id));
            host.connected = Some(is_connected(&host.id).await);
            hosts.push(host);
        }
        for mut host in saved {
            host.connected = Some(is_connected(&host.id).await);
            hosts.push(host);
        }
        Ok(hosts)
    }

    pub async fn save(&self, input: RemoteHost) -> AppResult<RemoteHost> {
        let _guard = self.lock.lock().await;
        let mut hosts = saved_hosts()?;
        if input.name.trim().is_empty() || !host_name_ok(&input.hostname) {
            return Err(AppError::machine("HOST_INVALID"));
        }
        if input.user.as_ref().is_some_and(|user| !user_ok(user)) {
            return Err(AppError::machine("USER_INVALID"));
        }
        if input.port.is_some_and(|port| port == 0) {
            return Err(AppError::machine("PORT_INVALID"));
        }
        if input.id.is_empty() {
            let host = RemoteHost {
                id: format!("web-{}", uuid::Uuid::new_v4()),
                source: "web".into(),
                ..input
            };
            hosts.push(host.clone());
            write_saved(&hosts)?;
            return Ok(host);
        }
        if let Some(existing) = hosts.iter_mut().find(|h| h.id == input.id) {
            *existing = RemoteHost {
                source: "web".into(),
                ..input
            };
            let saved = existing.clone();
            write_saved(&hosts)?;
            return Ok(saved);
        }
        Err(AppError::machine("HOST_READ_ONLY"))
    }

    pub async fn delete(&self, id: &str) -> AppResult<()> {
        let _guard = self.lock.lock().await;
        let mut hosts = saved_hosts()?;
        let before = hosts.len();
        hosts.retain(|h| h.id != id);
        if hosts.len() == before {
            return Err(AppError::machine("HOST_READ_ONLY"));
        }
        write_saved(&hosts)?;
        Ok(())
    }

    pub async fn set_visibility(&self, id: &str, visible: bool) -> AppResult<()> {
        let _guard = self.lock.lock().await;
        if !config_hosts()?.iter().any(|h| h.id == id) {
            return Err(AppError::machine("HOST_READ_ONLY"));
        }
        let mut hidden = hidden_config_hosts()?;
        if visible {
            hidden.remove(id);
        } else {
            hidden.insert(id.to_string());
        }
        let mut values: Vec<_> = hidden.into_iter().collect();
        values.sort();
        atomic_write(
            &remote_host_visibility_file(),
            &serde_json::to_string_pretty(&values)?,
        )?;
        Ok(())
    }
}

fn write_saved(hosts: &[RemoteHost]) -> AppResult<()> {
    atomic_write(&remote_hosts_file(), &serde_json::to_string_pretty(hosts)?)?;
    Ok(())
}

fn saved_hosts() -> AppResult<Vec<RemoteHost>> {
    match std::fs::read_to_string(remote_hosts_file()) {
        Ok(raw) => Ok(serde_json::from_str(&raw)?),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(vec![]),
        Err(error) => Err(error.into()),
    }
}

fn hidden_config_hosts() -> AppResult<HashSet<String>> {
    match std::fs::read_to_string(remote_host_visibility_file()) {
        Ok(raw) => {
            let value: ValueOrList = serde_json::from_str(&raw).unwrap_or(ValueOrList(vec![]));
            Ok(value.0.into_iter().collect())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(HashSet::new()),
        Err(error) => Err(error.into()),
    }
}

#[derive(serde::Deserialize)]
struct ValueOrList(Vec<String>);

fn config_hosts() -> AppResult<Vec<RemoteHost>> {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    read_config(home.join(".ssh/config"), &mut HashSet::new())
}

fn read_config(path: PathBuf, seen: &mut HashSet<PathBuf>) -> AppResult<Vec<RemoteHost>> {
    if !seen.insert(path.clone()) || seen.len() > 64 {
        return Ok(vec![]);
    }
    let Ok(contents) = std::fs::read_to_string(&path) else {
        return Ok(vec![]);
    };
    let mut hosts = Vec::new();
    let mut active: Vec<usize> = vec![];
    let alias = Regex::new(r"^[a-zA-Z0-9][a-zA-Z0-9._-]*$").unwrap();
    for line in contents.lines() {
        let words = tokenize(line);
        let Some(directive) = words.first().map(|s| s.to_ascii_lowercase()) else {
            continue;
        };
        if directive == "host" {
            active.clear();
            for name in words.iter().skip(1) {
                if name.starts_with('#') {
                    break;
                }
                if alias.is_match(name) {
                    active.push(hosts.len());
                    hosts.push(RemoteHost {
                        id: name.clone(),
                        name: name.clone(),
                        hostname: name.clone(),
                        user: None,
                        port: None,
                        identity_file: None,
                        source: "config".into(),
                        visible: None,
                        connected: None,
                    });
                }
            }
        } else if directive == "hostname" {
            if let Some(value) = words.get(1) {
                for index in &active {
                    hosts[*index].hostname = value.clone();
                }
            }
        } else if directive == "user" {
            if let Some(value) = words.get(1) {
                for index in &active {
                    hosts[*index].user = Some(value.clone());
                }
            }
        } else if directive == "port" {
            if let Some(value) = words.get(1).and_then(|s| s.parse().ok()) {
                for index in &active {
                    hosts[*index].port = Some(value);
                }
            }
        } else if directive == "identityfile" {
            // First one wins, matching OpenSSH's behaviour of keeping the
            // earliest `IdentityFile` for a host block.
            if let Some(value) = words.get(1) {
                for index in &active {
                    if hosts[*index].identity_file.is_none() {
                        hosts[*index].identity_file = Some(value.clone());
                    }
                }
            }
        } else if directive == "include" {
            for pattern in words.iter().skip(1) {
                if pattern.starts_with('#') {
                    break;
                }
                let expanded = expand_include(pattern);
                if let Ok(paths) = glob::glob(&expanded) {
                    for path in paths.flatten() {
                        hosts.extend(read_config(path, seen)?);
                    }
                }
            }
        }
    }
    let mut unique = Vec::new();
    let mut ids = HashSet::new();
    for host in hosts {
        if ids.insert(host.id.clone()) {
            unique.push(host);
        }
    }
    Ok(unique)
}

fn tokenize(line: &str) -> Vec<String> {
    let re = Regex::new(r#""[^"]*"|'[^']*'|[^\s=]+"#).unwrap();
    re.find_iter(line)
        .map(|m| {
            m.as_str()
                .trim_matches(|c| c == '"' || c == '\'')
                .to_string()
        })
        .collect()
}

fn expand_include(pattern: &str) -> String {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    let replaced = pattern.replacen('~', &home.to_string_lossy(), 1);
    if std::path::Path::new(&replaced).is_absolute() {
        replaced
    } else {
        home.join(".ssh")
            .join(replaced)
            .to_string_lossy()
            .into_owned()
    }
}

fn host_name_ok(value: &str) -> bool {
    Regex::new(r"^[a-zA-Z0-9][a-zA-Z0-9.:-]*$")
        .unwrap()
        .is_match(value)
}

fn user_ok(value: &str) -> bool {
    Regex::new(r"^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$")
        .unwrap()
        .is_match(value)
}

pub fn saved_host(id: &str) -> AppResult<Option<RemoteHost>> {
    Ok(saved_hosts()?.into_iter().find(|h| h.id == id))
}

/// Look a host id up in the saved hosts, then in `~/.ssh/config`.
///
/// `saved_host` alone is not enough any more: Que resolves connection
/// parameters itself instead of leaving it to the `ssh` binary, so it needs the
/// full alias table — including each entry's `IdentityFile`.
pub fn resolve(id: &str) -> AppResult<Option<RemoteHost>> {
    if let Some(host) = saved_host(id)? {
        return Ok(Some(host));
    }
    Ok(config_hosts()?.into_iter().find(|host| host.id == id))
}

/// The `IdentityFile` `~/.ssh/config` associates with an alias, if any.
///
/// A saved host carries no identity file of its own, but its hostname may still
/// be an alias in the config, so callers check both.
pub fn identity_file(alias: &str) -> Option<String> {
    config_hosts()
        .ok()?
        .into_iter()
        .find(|host| host.id == alias)
        .and_then(|host| host.identity_file)
}
