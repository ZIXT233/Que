//! Remote SSH transport, owned by Que instead of shelled out to `ssh`.
//!
//! Historically every remote session spawned the system `ssh` binary inside a
//! local ConPTY. That worked, but it made the remote pty's size a guess (the
//! window was whatever `ssh.exe` managed to read back out of ConPTY), pushed
//! Ctrl-C through conhost's processed-input translation, required the user to
//! have `ssh.exe` installed, and — because Win32-OpenSSH has no ControlMaster —
//! forced authentication to be replayed for every invocation through an askpass
//! helper plus an in-memory password cache.
//!
//! Talking the protocol directly through `russh` removes all four:
//!
//! * the pty is created with an explicit size and resized with an explicit
//!   `window-change`, so the remote TUI can never disagree with the front end;
//! * Ctrl-C is `0x03` on the wire, nothing more;
//! * no external binary is needed on any platform;
//! * one authenticated connection is pooled per host and reused by both the
//!   interactive terminal channel and by one-shot `exec` calls, so credentials
//!   are never cached in a side channel.
//!
//! `~/.ssh/known_hosts` stays the source of truth for host identity, which
//! keeps Que interoperable with the user's existing `ssh` trust decisions.

use crate::error::{AppError, AppResult};
use crate::models::RemoteHost;
use parking_lot::Mutex;
use russh::client::{self, Handle, KeyboardInteractiveAuthResponse};
use russh::keys::agent::client::{AgentClient, AgentStream};
use russh::keys::known_hosts::{
    check_known_hosts, check_known_hosts_path, learn_known_hosts, learn_known_hosts_path,
};
use russh::keys::{
    load_secret_key, HashAlg, PrivateKeyWithHashAlg, PublicKey, PublicKeyOrCertificate,
};
use russh::{ChannelMsg, Disconnect, Sig};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tokio::sync::{mpsc, Mutex as AsyncMutex};

/// How long we wait for TCP connect plus key exchange.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(8);
/// How long we wait for authentication. Longer than the connect timeout because
/// a publickey attempt may involve an agent round trip.
const AUTH_TIMEOUT: Duration = Duration::from_secs(60);
/// Rounds of keyboard-interactive prompting we are willing to answer. Servers
/// normally send one round of "Password:"; more than a few is a PAM chain we do
/// not try to satisfy.
const KBI_ROUNDS: usize = 4;

/// Everything needed to reach a host: the id Que keys everything by, plus the
/// resolved connection parameters.
#[derive(Clone)]
pub struct Target {
    pub id: String,
    pub hostname: String,
    pub user: String,
    pub port: u16,
    /// `IdentityFile` from `~/.ssh/config`, resolved relative to `~/.ssh` when
    /// it is not absolute. Unset for saved hosts typed into the UI.
    pub identity_file: Option<String>,
}

impl Target {
    /// Normalize a stored host record into connection parameters.
    ///
    /// Two shapes need patching up here: the ad-hoc `user@host` form the user
    /// can type directly, and `~/.ssh/config` entries where the alias carries
    /// the user while `HostName` carries the real name.
    pub fn from_host(host: &RemoteHost) -> Target {
        let mut hostname = host.hostname.trim().to_string();
        let mut user = host.user.clone().filter(|value| !value.trim().is_empty());
        let alias_user = host
            .id
            .split_once('@')
            .map(|(left, _)| left.to_string())
            .filter(|value| !value.is_empty());
        if let Some((left, right)) = hostname.clone().split_once('@') {
            if user.is_none() && !left.is_empty() {
                user = Some(left.to_string());
            }
            hostname = right.to_string();
        } else if user.is_none() {
            user = alias_user;
        }
        Target {
            id: host.id.clone(),
            hostname: hostname.clone(),
            user: user.unwrap_or_else(local_user),
            port: host.port.unwrap_or(22),
            // A saved host has no identity file of its own, but its hostname may
            // still be an alias in `~/.ssh/config`, which is how the system
            // `ssh` client used to find the key.
            identity_file: host
                .identity_file
                .clone()
                .or_else(|| crate::hosts::identity_file(&host.id))
                .or_else(|| crate::hosts::identity_file(&hostname)),
        }
    }

    fn label(&self) -> String {
        format!("{}@{}:{}", self.user, self.hostname, self.port)
    }
}

/// Resolve a Que host id — a saved host, or an alias from `~/.ssh/config` —
/// into connection parameters.
pub fn resolve(id: &str) -> AppResult<Target> {
    let target = resolve_inner(id)?;
    crate::debuglog::log(&format!(
        "remote: resolved id={id:?} -> hostname={:?} user={:?} port={} identity_file={:?}",
        target.hostname, target.user, target.port, target.identity_file
    ));
    Ok(target)
}

fn resolve_inner(id: &str) -> AppResult<Target> {
    if !host_ok(id) {
        crate::debuglog::log(&format!(
            "remote: resolve rejected id={id:?} (HOST_INVALID)"
        ));
        return Err(AppError::machine("HOST_INVALID"));
    }
    let saved = crate::hosts::resolve(id)?;
    if id.starts_with("web-") && saved.is_none() {
        crate::debuglog::log(&format!(
            "remote: resolve failed id={id:?} (HOST_DELETED, no saved host)"
        ));
        return Err(AppError::machine("HOST_DELETED"));
    }
    let host = saved.unwrap_or(RemoteHost {
        id: id.to_string(),
        name: id.to_string(),
        hostname: id.to_string(),
        user: None,
        port: None,
        identity_file: None,
        source: "config".into(),
        visible: None,
        connected: None,
    });
    Ok(Target::from_host(&host))
}

fn host_ok(value: &str) -> bool {
    regex::Regex::new(r"^[a-zA-Z0-9][a-zA-Z0-9._@:-]*$")
        .unwrap()
        .is_match(value)
}

fn local_user() -> String {
    for key in ["USER", "LOGNAME", "USERNAME"] {
        if let Ok(value) = std::env::var(key) {
            if !value.trim().is_empty() {
                return value;
            }
        }
    }
    "root".into()
}

// ---------------------------------------------------------------------------
// Host key verification
// ---------------------------------------------------------------------------

#[derive(Default)]
struct Trust {
    /// Fingerprint prompt for a key the user has not accepted yet.
    prompt: Option<String>,
    /// Set when a key was refused for a reason the user cannot accept away.
    fatal: Option<String>,
}

/// The text the user is asked to confirm, and the exact token that comes back
/// when they accept it. One function produces both, so the two cannot drift.
fn trust_prompt(host: &str, port: u16, key: &PublicKey) -> String {
    let label = if port == 22 {
        host.to_string()
    } else {
        format!("[{host}]:{port}")
    };
    format!(
        "The authenticity of host '{label}' can't be established.\n{} key fingerprint is {}.",
        key.algorithm(),
        key.fingerprint(HashAlg::Sha256)
    )
}

/// Host identity normally lives in the user's own `~/.ssh/known_hosts`, which is
/// what keeps Que interoperable with the `ssh` they already use. `QUE_KNOWN_HOSTS`
/// points verification at a different file instead — the end-to-end test relies
/// on it so it never touches the real trust store.
fn known_hosts_override() -> Option<PathBuf> {
    std::env::var_os("QUE_KNOWN_HOSTS").map(PathBuf::from)
}

fn verify_host(host: &str, port: u16, key: &PublicKey) -> Result<bool, russh::keys::Error> {
    match known_hosts_override() {
        Some(path) => check_known_hosts_path(host, port, key, path),
        None => check_known_hosts(host, port, key),
    }
}

fn record_host(host: &str, port: u16, key: &PublicKey) -> Result<(), russh::keys::Error> {
    match known_hosts_override() {
        Some(path) => learn_known_hosts_path(host, port, key, path),
        None => learn_known_hosts(host, port, key),
    }
}

struct Client {
    host: String,
    port: u16,
    /// Prompt the user already accepted, if any.
    accept: Option<String>,
    trust: Arc<Mutex<Trust>>,
}

impl client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let key = match server_public_key {
            PublicKeyOrCertificate::PublicKey { key, .. } => key,
            // A CA-signed host certificate cannot be pinned in known_hosts the
            // way a bare key can, and Que has no `@cert-authority` config, so
            // silently trusting it would be a downgrade. Refuse, and say why.
            PublicKeyOrCertificate::Certificate(certificate) => {
                let reason = format!(
                    "{} presented a host certificate ({}), which Que cannot pin yet. Connect once with ssh to record the host key.",
                    self.host,
                    certificate.algorithm()
                );
                crate::debuglog::log(&format!(
                    "remote: host key check on {} -> REFUSED certificate ({})",
                    self.host,
                    certificate.algorithm()
                ));
                self.trust.lock().fatal = Some(reason);
                return Ok(false);
            }
        };
        let fingerprint = key.fingerprint(HashAlg::Sha256).to_string();
        match verify_host(&self.host, self.port, key) {
            Ok(true) => {
                crate::debuglog::log(&format!(
                    "remote: host key check on {} -> PINNED ({fingerprint})",
                    self.host
                ));
                Ok(true)
            }
            Ok(false) => {
                let prompt = trust_prompt(&self.host, self.port, key);
                crate::debuglog::log(&format!(
                    "remote: host key check on {} -> UNKNOWN ({fingerprint}); user-accepted prompt matches: {}",
                    self.host,
                    self.accept.as_deref() == Some(prompt.as_str())
                ));
                if self.accept.as_deref() == Some(prompt.as_str()) {
                    if let Err(error) = record_host(&self.host, self.port, key) {
                        crate::debuglog::log(&format!(
                            "remote: learning host key for {} FAILED: {error}",
                            self.host
                        ));
                        self.trust.lock().fatal =
                            Some(format!("Could not record the host key: {error}"));
                        return Ok(false);
                    }
                    crate::debuglog::log(&format!("remote: learned host key for {}", self.host));
                    return Ok(true);
                }
                self.trust.lock().prompt = Some(prompt);
                Ok(false)
            }
            // known_hosts holds a different key for this host: exactly the case
            // worth stopping on, so surface it as its own code instead of the
            // generic "unknown host" flow.
            Err(error) => {
                crate::debuglog::log(&format!(
                    "remote: host key check on {} -> MISMATCH/ERROR: {error}",
                    self.host
                ));
                Err(error.into())
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

struct Pooled {
    session: Arc<Session>,
    /// Last password that authenticated successfully. No OS keyring is
    /// involved; this exists only so a pooled connection that dropped can be
    /// re-established without asking the user again.
    password: Option<String>,
}

pub struct Session {
    handle: AsyncMutex<Handle<Client>>,
    target: Target,
}

impl Session {
    async fn closed(&self) -> bool {
        self.handle.lock().await.is_closed()
    }

    async fn disconnect(&self) {
        crate::debuglog::log(&format!("remote: closing {}", self.target.label()));
        let guard = self.handle.lock().await;
        let _ = guard.disconnect(Disconnect::ByApplication, "", "").await;
    }
}

fn pool() -> &'static AsyncMutex<HashMap<String, Pooled>> {
    static POOL: OnceLock<AsyncMutex<HashMap<String, Pooled>>> = OnceLock::new();
    POOL.get_or_init(|| AsyncMutex::new(HashMap::new()))
}

/// The pooled session for a Que host id, connecting if it is not up yet.
pub async fn session_with(
    host: &str,
    password: Option<String>,
    accept: Option<String>,
) -> AppResult<Arc<Session>> {
    let target = resolve(host)?;
    connect_pooled(&target, password, accept).await
}

/// The pooled session for an explicit target, used to validate a host before it
/// is saved.
pub async fn connect_target(
    target: &Target,
    password: Option<String>,
    accept: Option<String>,
) -> AppResult<Arc<Session>> {
    connect_pooled(target, password, accept).await
}

async fn connect_pooled(
    target: &Target,
    password: Option<String>,
    accept: Option<String>,
) -> AppResult<Arc<Session>> {
    let mut guard = pool().lock().await;
    let existing = guard
        .get(&target.id)
        .map(|entry| (entry.session.clone(), entry.password.clone()));
    // A reconnect for the same host can reuse whatever password worked before.
    let password = match &existing {
        Some((_, cached)) => password.or_else(|| cached.clone()),
        None => password,
    };
    if let Some((session, _)) = existing {
        if !session.closed().await {
            crate::debuglog::log(&format!("remote: pooled session alive for {}", target.id));
            return Ok(session);
        }
        crate::debuglog::log(&format!(
            "remote: pooled session for {} is dead, re-dialling",
            target.id
        ));
        guard.remove(&target.id);
    }
    drop(guard);
    crate::debuglog::log(&format!("remote: no live pooled session for {}, dialling (password supplied: {}, trusted prompt supplied: {})", target.id, password.is_some(), accept.is_some()));

    let session = Arc::new(connect(target, password.clone(), accept).await?);
    let mut guard = pool().lock().await;
    // Another caller may have connected the same host while we were busy; keep
    // whichever landed first so no channel outlives its session.
    let winner = guard.get(&target.id).map(|entry| entry.session.clone());
    if let Some(winner) = winner {
        if !winner.closed().await {
            crate::debuglog::log(&format!(
                "remote: another caller dialled {} first; discarding our session",
                target.id
            ));
            drop(guard);
            let _ = session.disconnect().await;
            return Ok(winner);
        }
        guard.remove(&target.id);
    }
    guard.insert(
        target.id.clone(),
        Pooled {
            session: session.clone(),
            password,
        },
    );
    crate::debuglog::log(&format!("remote: pooled new session for {}", target.id));
    Ok(session)
}

async fn connect(
    target: &Target,
    password: Option<String>,
    accept: Option<String>,
) -> AppResult<Session> {
    let trust = Arc::new(Mutex::new(Trust::default()));
    let handler = Client {
        host: target.hostname.clone(),
        port: target.port,
        accept,
        trust: trust.clone(),
    };
    let config = Arc::new(client::Config {
        keepalive_interval: Some(Duration::from_secs(15)),
        keepalive_max: 3,
        nodelay: true,
        ..Default::default()
    });
    crate::debuglog::log(&format!("remote: connecting to {}", target.label()));
    let started = std::time::Instant::now();
    let opened = tokio::time::timeout(
        CONNECT_TIMEOUT,
        client::connect(config, (target.hostname.as_str(), target.port), handler),
    )
    .await;
    let handle = match opened {
        Err(_) => {
            crate::debuglog::error(
                "ssh",
                &format!(
                    "connect {} timed out after {}s",
                    target.label(),
                    CONNECT_TIMEOUT.as_secs()
                ),
            );
            return Err(AppError::machine("TIMEOUT"));
        }
        Ok(Err(error)) => {
            // Log the raw russh error text first: it is the most precise signal
            // of what actually failed on the wire, before classification.
            crate::debuglog::error(
                "ssh",
                &format!(
                    "connect {} failed after {}ms: {error}",
                    target.label(),
                    started.elapsed().as_millis()
                ),
            );
            let error = classify(&error, &trust);
            crate::debuglog::log_error("remote connect classified", &error);
            return Err(error);
        }
        Ok(Ok(handle)) => {
            crate::debuglog::info(
                "ssh",
                &format!(
                    "connected {} in {}ms",
                    target.label(),
                    started.elapsed().as_millis()
                ),
            );
            handle
        }
    };
    let session = Session {
        handle: AsyncMutex::new(handle),
        target: target.clone(),
    };
    let auth_started = std::time::Instant::now();
    match tokio::time::timeout(
        AUTH_TIMEOUT,
        authenticate(&session, target, password.as_deref()),
    )
    .await
    {
        Ok(Ok(())) => {
            crate::debuglog::info(
                "ssh",
                &format!(
                    "auth ok {} in {}ms",
                    target.label(),
                    auth_started.elapsed().as_millis()
                ),
            );
            Ok(session)
        }
        Ok(Err(error)) => {
            crate::debuglog::error(
                "ssh",
                &format!(
                    "auth failed {} after {}ms",
                    target.label(),
                    auth_started.elapsed().as_millis()
                ),
            );
            crate::debuglog::log_error("remote auth", &error);
            session.disconnect().await;
            Err(error)
        }
        Err(_) => {
            crate::debuglog::error(
                "ssh",
                &format!(
                    "auth timed out {} after {}s",
                    target.label(),
                    AUTH_TIMEOUT.as_secs()
                ),
            );
            session.disconnect().await;
            Err(AppError::machine("TIMEOUT"))
        }
    }
}

/// Whether Que currently holds an authenticated connection to `host`.
pub async fn is_connected(host: &str) -> bool {
    let Ok(target) = resolve(host) else {
        return false;
    };
    let guard = pool().lock().await;
    match guard.get(&target.id) {
        Some(entry) => !entry.session.closed().await,
        None => false,
    }
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

/// `AgentClient` is generic over its stream, so each connect path would be a
/// different type. `dynamic()` erases that, letting one loop try whichever
/// agent this platform happens to have.
type AnyAgent = AgentClient<Box<dyn AgentStream + Send + Unpin>>;

async fn agent_client() -> Option<AnyAgent> {
    #[cfg(unix)]
    {
        // Covers Linux `$SSH_AUTH_SOCK` and the launchd socket macOS sets.
        if let Ok(agent) = AgentClient::connect_env().await {
            return Some(agent.dynamic());
        }
    }
    #[cfg(windows)]
    {
        // The OpenSSH agent service's well-known pipe, then PuTTY's Pageant.
        if let Ok(agent) = AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent").await {
            return Some(agent.dynamic());
        }
        if let Ok(agent) = AgentClient::connect_pageant().await {
            return Some(agent.dynamic());
        }
    }
    None
}

/// Candidate private keys, in the order OpenSSH itself would try them: whatever
/// `~/.ssh/config` names for this host first, then the default file names.
fn key_paths(identity_file: Option<&str>) -> Vec<PathBuf> {
    let Some(home) = dirs::home_dir() else {
        return vec![];
    };
    let ssh = home.join(".ssh");
    let mut paths = Vec::new();
    if let Some(value) = identity_file {
        let expanded = crate::paths::expand_user(value);
        paths.push(if expanded.is_absolute() {
            expanded
        } else {
            ssh.join(expanded)
        });
    }
    for name in ["id_ed25519", "id_ecdsa", "id_rsa"] {
        paths.push(ssh.join(name));
    }
    paths
}

async fn authenticate(session: &Session, target: &Target, password: Option<&str>) -> AppResult<()> {
    let mut guard = session.handle.lock().await;
    let handle = &mut *guard;
    // Asking for this once keeps the extension-info round trip out of the
    // per-key loop.
    let rsa_hash = handle
        .best_supported_rsa_hash()
        .await
        .ok()
        .flatten()
        .flatten();
    let mut attempts = 0u32;
    crate::debuglog::log(&format!(
        "remote: auth {} user={:?} rsa_hash={:?} password_supplied={} agent_available={}",
        target.label(),
        target.user,
        rsa_hash.is_some(),
        password.is_some(),
        agent_probe().await
    ));

    if let Some(mut agent) = agent_client().await {
        match agent.request_identities().await {
            Ok(identities) => {
                crate::debuglog::log(&format!(
                    "remote: ssh-agent offered {} identity/identities",
                    identities.len()
                ));
                for identity in identities {
                    let key = identity.public_key().into_owned();
                    attempts += 1;
                    let fingerprint = key.fingerprint(HashAlg::Sha256).to_string();
                    match handle
                        .authenticate_publickey_with(target.user.clone(), key, rsa_hash, &mut agent)
                        .await
                    {
                        Ok(result) if result.success() => {
                            crate::debuglog::log(&format!(
                                "remote: authenticated with ssh-agent key {fingerprint}"
                            ));
                            return Ok(());
                        }
                        Ok(_) => crate::debuglog::log(&format!(
                            "remote: ssh-agent key {fingerprint} REJECTED by server"
                        )),
                        Err(error) => crate::debuglog::log(&format!(
                            "remote: ssh-agent key {fingerprint} attempt errored: {error}"
                        )),
                    }
                }
            }
            Err(error) => crate::debuglog::log(&format!(
                "remote: ssh-agent reachable but request_identities failed: {error}"
            )),
        }
    }

    for path in key_paths(target.identity_file.as_deref()) {
        if !path.is_file() {
            continue;
        }
        // An encrypted key is unlocked with the password the user supplied; a
        // wrong or missing one simply fails to load and we try the next file.
        let key = match load_secret_key(&path, password) {
            Ok(key) => key,
            Err(error) => {
                crate::debuglog::log(&format!("remote: key {} present but not loaded (encrypted without password, or unreadable): {error}", path.display()));
                continue;
            }
        };
        attempts += 1;
        match handle
            .authenticate_publickey(
                target.user.clone(),
                PrivateKeyWithHashAlg::new(Arc::new(key), rsa_hash),
            )
            .await
        {
            Ok(result) if result.success() => {
                crate::debuglog::log(&format!("remote: authenticated with {}", path.display()));
                return Ok(());
            }
            Ok(_) => crate::debuglog::log(&format!(
                "remote: key {} REJECTED by server",
                path.display()
            )),
            Err(error) => crate::debuglog::log(&format!(
                "remote: key {} attempt errored: {error}",
                path.display()
            )),
        }
    }

    if let Some(password) = password {
        attempts += 1;
        match handle
            .authenticate_password(target.user.clone(), password)
            .await
        {
            Ok(result) if result.success() => {
                crate::debuglog::log("remote: authenticated with password");
                return Ok(());
            }
            Ok(_) => crate::debuglog::log(
                "remote: password auth REJECTED by server; trying keyboard-interactive",
            ),
            Err(error) => {
                crate::debuglog::log(&format!("remote: password auth attempt errored: {error}"))
            }
        }
        // Servers behind PAM often accept the password only through
        // keyboard-interactive, a method separate from `password`.
        match handle
            .authenticate_keyboard_interactive_start(target.user.clone(), None::<String>)
            .await
        {
            Ok(mut response) => {
                for round in 0..KBI_ROUNDS {
                    let answers = match &response {
                        KeyboardInteractiveAuthResponse::Success => {
                            crate::debuglog::log("remote: authenticated with keyboard-interactive");
                            return Ok(());
                        }
                        KeyboardInteractiveAuthResponse::Failure { .. } => {
                            crate::debuglog::log("remote: keyboard-interactive REJECTED by server");
                            break;
                        }
                        KeyboardInteractiveAuthResponse::InfoRequest { prompts, .. } => {
                            crate::debuglog::log(&format!("remote: keyboard-interactive round {round}: {} prompt(s), answering with the password", prompts.len()));
                            vec![password.to_string(); prompts.len()]
                        }
                    };
                    match handle
                        .authenticate_keyboard_interactive_respond(answers)
                        .await
                    {
                        Ok(next) => response = next,
                        Err(error) => {
                            crate::debuglog::log(&format!(
                                "remote: keyboard-interactive respond errored: {error}"
                            ));
                            break;
                        }
                    }
                }
            }
            Err(error) => crate::debuglog::log(&format!(
                "remote: keyboard-interactive start errored: {error}"
            )),
        }
    } else {
        crate::debuglog::log(
            "remote: no password available; agent and key files did not authenticate",
        );
    }

    crate::debuglog::log(&format!(
        "remote: authentication failed after {attempts} attempt(s)"
    ));
    Err(AppError::machine("AUTH_REQUIRED"))
}

/// Whether any ssh-agent connect path succeeds on this machine — logged before
/// the real attempts so "agent missing" and "agent refused the key" are
/// distinguishable in the log.
async fn agent_probe() -> &'static str {
    #[cfg(windows)]
    {
        if AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent")
            .await
            .is_ok()
        {
            return "named-pipe";
        }
        if AgentClient::connect_pageant().await.is_ok() {
            return "pageant";
        }
        "none"
    }
    #[cfg(unix)]
    {
        if AgentClient::connect_env().await.is_ok() {
            return "env-socket";
        }
        "none"
    }
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

fn classify(error: &russh::Error, trust: &Arc<Mutex<Trust>>) -> AppError {
    let state = trust.lock();
    if let Some(message) = &state.fatal {
        return AppError::msg(message.clone());
    }
    if let Some(prompt) = &state.prompt {
        return AppError::Machine {
            code: "HOST_TRUST_REQUIRED".into(),
            prompt: Some(prompt.clone()),
            detail: None,
        };
    }
    let code = match error {
        russh::Error::UnknownKey => "HOST_TRUST_REQUIRED",
        russh::Error::KeyChanged { .. } => "HOST_KEY",
        russh::Error::Keys(russh::keys::Error::KeyChanged { .. }) => "HOST_KEY",
        russh::Error::IO(io) => match io.kind() {
            std::io::ErrorKind::ConnectionRefused => "REFUSED",
            std::io::ErrorKind::TimedOut => "TIMEOUT",
            _ => code_from_text(&error.to_string()),
        },
        russh::Error::ConnectionTimeout
        | russh::Error::KeepaliveTimeout
        | russh::Error::InactivityTimeout => "TIMEOUT",
        _ => code_from_text(&error.to_string()),
    };
    AppError::machine(code)
}

/// `client::connect` reports name resolution failures as an opaque
/// `Uncategorized` IO error on Windows and a lookup error on Unix, so the text
/// is the only portable signal left.
fn code_from_text(text: &str) -> &'static str {
    let lower = text.to_ascii_lowercase();
    if lower.contains("failed to lookup address")
        || lower.contains("no such host")
        || lower.contains("name or service not known")
        || lower.contains("nodename nor servname")
    {
        "HOST_NOT_FOUND"
    } else if lower.contains("connection refused") {
        "REFUSED"
    } else if lower.contains("timed out") || lower.contains("timeout") {
        "TIMEOUT"
    } else {
        "CONNECTION_FAILED"
    }
}

/// Map a remote command's stderr into Que's machine codes. Only the directory
/// case needs one — remote browsing and workspace validation both depend on
/// telling "no such directory" apart from "the host went away".
fn exec_error(stderr: &[u8], code: i32) -> AppError {
    let text = String::from_utf8_lossy(stderr).trim().to_string();
    if text.is_empty() {
        return AppError::msg(format!("远程命令以退出码 {code} 结束"));
    }
    let lower = text.to_ascii_lowercase();
    if lower.contains("not a directory")
        || lower.contains("can't cd")
        || lower.contains("no such file or directory")
    {
        // Keep the code so the UI can route, but carry the remote's own words —
        // "无法读取目录" with no path tells the user nothing.
        return AppError::machine_detail("DIRECTORY", crate::debuglog::clip(&text, 400));
    }
    AppError::msg(crate::debuglog::clip(&text, 400))
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

/// What the terminal backend can ask a live remote channel to do. Everything
/// funnels through one queue so `TerminalHub`'s write/resize/kill stay
/// synchronous for their callers.
#[derive(Debug)]
pub enum PtyCommand {
    Data(Vec<u8>),
    Resize(u16, u16),
    Close,
}

/// Hex preview of bytes for the wire-level log; never dumps the whole payload.
pub(crate) fn hex_prefix(bytes: &[u8], max: usize) -> String {
    let shown: Vec<String> = bytes.iter().take(max).map(|b| format!("{b:02x}")).collect();
    let suffix = if bytes.len() > max { "…" } else { "" };
    format!("{}{suffix}", shown.join(" "))
}

/// OSC 10/11 color-query experiment: chunks that carry an OSC sequence get a
/// full hex dump plus an epoch-ms timestamp that lines up with the frontend
/// `osc` lines; everything else keeps the short preview.
fn wire_trace(direction: &str, bytes: &[u8]) {
    if !bytes.windows(2).any(|w| w == b"\x1b]") {
        crate::debuglog::trace(
            "pty",
            &format!("{direction} {}B: {}", bytes.len(), hex_prefix(bytes, 48)),
        );
        return;
    }
    let t = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    crate::debuglog::debug(
        "osc",
        &format!(
            "{direction} t={t} {}B: {}",
            bytes.len(),
            hex_prefix(bytes, 512)
        ),
    );
}

/// Drive a remote login/command session for its whole lifetime.
///
/// `sink` receives every byte the remote side writes, already demultiplexed
/// from the protocol. The return value is the remote exit status; a transport
/// failure comes back as an error, with whatever bytes were already delivered
/// left in place.
pub async fn run_pty<S>(
    host: &str,
    command: &str,
    cols: u16,
    rows: u16,
    sink: S,
    commands: mpsc::UnboundedReceiver<PtyCommand>,
) -> AppResult<i32>
where
    S: Fn(Vec<u8>) + Send + 'static,
{
    let target = resolve(host)?;
    run_pty_target(&target, command, cols, rows, sink, commands).await
}

/// [`run_pty`] against connection parameters that are already resolved.
pub async fn run_pty_target<S>(
    target: &Target,
    command: &str,
    cols: u16,
    rows: u16,
    sink: S,
    mut commands: mpsc::UnboundedReceiver<PtyCommand>,
) -> AppResult<i32>
where
    S: Fn(Vec<u8>) + Send + 'static,
{
    let session = connect_target(target, None, None).await?;
    let channel = {
        let guard = session.handle.lock().await;
        guard.channel_open_session().await.map_err(|error| {
            crate::debuglog::error(
                "pty",
                &format!("channel_open_session failed on {}: {error}", target.label()),
            );
            AppError::msg(error.to_string())
        })?
    };
    let (mut reader, writer) = channel.split();
    writer
        .request_pty(true, "xterm-256color", cols as u32, rows as u32, 0, 0, &[])
        .await
        .map_err(|error| {
            crate::debuglog::error(
                "pty",
                &format!("request_pty failed on {}: {error}", target.label()),
            );
            AppError::msg(error.to_string())
        })?;
    writer
        .exec(true, command.to_string())
        .await
        .map_err(|error| {
            crate::debuglog::error(
                "pty",
                &format!("exec request failed on {}: {error}", target.label()),
            );
            AppError::msg(error.to_string())
        })?;
    crate::debuglog::log(&format!(
        "remote pty: running on {} at {cols}x{rows}: {}",
        target.label(),
        crate::debuglog::clip(command, 200)
    ));

    let mut exit_code = None;
    let mut end_reason = "remote closed (Eof/Close/None)";
    loop {
        tokio::select! {
            message = reader.wait() => match message {
                Some(ChannelMsg::Data { data }) => {
                    wire_trace("remote <-", &data);
                    sink(data.to_vec());
                }
                // A pty normally folds stderr into stdout; an exec channel does
                // not. Either way both are terminal output.
                Some(ChannelMsg::ExtendedData { data, .. }) => {
                    crate::debuglog::trace("pty", &format!("remote <- ext {}B: {}", data.len(), hex_prefix(&data, 48)));
                    sink(data.to_vec());
                }
                Some(ChannelMsg::ExitStatus { exit_status }) => {
                    crate::debuglog::debug("pty", &format!("remote exit status {exit_status}"));
                    exit_code = Some(exit_status as i32);
                }
                Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                _ => {}
            },
            command = commands.recv() => match command {
                Some(PtyCommand::Data(bytes)) => {
                    wire_trace("remote ->", &bytes);
                    if writer.data_bytes(bytes).await.is_err() {
                        end_reason = "write failed (channel gone)";
                        break;
                    }
                }
                Some(PtyCommand::Resize(cols, rows)) => {
                    if writer.window_change(cols as u32, rows as u32, 0, 0).await.is_err() {
                        end_reason = "window-change failed (channel gone)";
                        break;
                    }
                }
                // The front end closed the tab. Hang the remote job up so a
                // background process does not outlive its terminal.
                Some(PtyCommand::Close) | None => {
                    end_reason = "front end closed the tab";
                    let _ = writer.signal(Sig::HUP).await;
                    let _ = writer.close().await;
                    break;
                }
            },
        }
    }
    crate::debuglog::info(
        "pty",
        &format!("remote ended ({end_reason}) exit={:?}", exit_code),
    );
    Ok(exit_code.unwrap_or(0))
}

/// One-shot command over the pooled connection, no pty.
///
/// Note on locale: a non-tty exec gets no locale from the server, so a remote
/// `ls` can hand back `?` where a filename had CJK. Que deliberately does not
/// override `LANG` here — that stays a server-side setting, same as it was when
/// the system `ssh` client ran the command.
pub async fn exec(host: &str, command: &str, stdin: &[u8]) -> AppResult<Vec<u8>> {
    let target = resolve(host)?;
    exec_target(&target, command, stdin).await
}

/// [`exec`] against connection parameters that are already resolved.
pub async fn exec_target(target: &Target, command: &str, stdin: &[u8]) -> AppResult<Vec<u8>> {
    let session = connect_target(target, None, None).await?;
    let channel = {
        let guard = session.handle.lock().await;
        guard.channel_open_session().await.map_err(|error| {
            crate::debuglog::log(&format!(
                "remote exec: channel_open_session failed on {}: {error}",
                target.label()
            ));
            AppError::msg(error.to_string())
        })?
    };
    let (mut reader, writer) = channel.split();
    writer
        .exec(true, command.to_string())
        .await
        .map_err(|error| {
            crate::debuglog::log(&format!(
                "remote exec: exec request failed on {}: {error}",
                target.label()
            ));
            AppError::msg(error.to_string())
        })?;
    crate::debuglog::log(&format!(
        "remote exec: exec sent to {} (stdin {} bytes)",
        target.label(),
        stdin.len()
    ));
    if !stdin.is_empty() {
        writer
            .data_bytes(stdin.to_vec())
            .await
            .map_err(|error| AppError::msg(error.to_string()))?;
    }
    writer
        .eof()
        .await
        .map_err(|error| AppError::msg(error.to_string()))?;

    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut exit_code = None;
    loop {
        match reader.wait().await {
            Some(ChannelMsg::Data { data }) => stdout.extend_from_slice(&data),
            Some(ChannelMsg::ExtendedData { data, ext }) => {
                if ext == 1 {
                    stderr.extend_from_slice(&data);
                } else {
                    stdout.extend_from_slice(&data);
                }
            }
            Some(ChannelMsg::ExitStatus { exit_status }) => exit_code = Some(exit_status as i32),
            Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
            _ => {}
        }
    }
    match exit_code {
        Some(0) | None => Ok(stdout),
        Some(code) => {
            crate::debuglog::log(&format!(
                "remote exec failed: code={code} stderr={:?}",
                crate::debuglog::clip(&String::from_utf8_lossy(&stderr), 800)
            ));
            Err(exec_error(&stderr, code))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use russh::server::{
        Auth, ChannelOpenHandle, Msg as ServerMsg, Server as _, Session as ServerSession,
    };
    use std::net::SocketAddr;
    use tokio::net::TcpListener;

    /// A throwaway Ed25519 host key, made with `ssh-keygen -t ed25519`. The test
    /// server needs a stable identity so the client can be asked to trust one
    /// specific fingerprint.
    const HOST_KEY: &str = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\nQyNTUxOQAAACCI0tBbZPbI0tjbsoBYC6vtJ3WUpHPJZVlN/E785l2A8AAAAJjCCseBwgrH\ngQAAAAtzc2gtZWQyNTUxOQAAACCI0tBbZPbI0tjbsoBYC6vtJ3WUpHPJZVlN/E785l2A8A\nAAAECARsUtxAYKQ8Se5BlSBs5mmXaabBY7OISv17cSxink94jS0Ftk9sjS2NuygFgLq+0n\ndZSkc8llWU38TvzmXYDwAAAAEGN1ZS10ZXN0LWhvc3RrZXkBAgMEBQ==\n-----END OPENSSH PRIVATE KEY-----\n";

    const PASSWORD: &str = "secret";

    /// What the test server saw, so the test can assert on the wire, not on the
    /// client's own bookkeeping.
    #[derive(Default)]
    struct Recorded {
        pty: Option<(String, u32, u32)>,
        resizes: Vec<(u32, u32)>,
        commands: Vec<String>,
        received: Vec<u8>,
        /// How many times the client asked the server to hang the remote job up.
        hung_up: usize,
    }

    #[derive(Clone)]
    struct TestServer {
        recorded: Arc<Mutex<Recorded>>,
        id: usize,
    }

    impl russh::server::Server for TestServer {
        type Handler = Self;

        fn new_client(&mut self, _: Option<SocketAddr>) -> Self {
            self.id += 1;
            self.clone()
        }
    }

    impl russh::server::Handler for TestServer {
        type Error = russh::Error;

        async fn auth_password(
            &mut self,
            _user: &str,
            password: &str,
        ) -> Result<Auth, Self::Error> {
            Ok(if password == PASSWORD {
                Auth::Accept
            } else {
                Auth::Reject {
                    proceed_with_methods: None,
                    partial_success: false,
                }
            })
        }

        /// Always rejected, so the test exercises the password path even on a
        /// machine that happens to have an ssh-agent running.
        async fn auth_publickey(
            &mut self,
            _user: &str,
            _key: &russh::keys::ssh_key::PublicKey,
        ) -> Result<Auth, Self::Error> {
            Ok(Auth::Reject {
                proceed_with_methods: None,
                partial_success: false,
            })
        }

        async fn channel_open_session(
            &mut self,
            _channel: russh::Channel<ServerMsg>,
            reply: ChannelOpenHandle,
            _session: &mut ServerSession,
        ) -> Result<(), Self::Error> {
            reply.accept().await;
            Ok(())
        }

        async fn pty_request(
            &mut self,
            channel: russh::ChannelId,
            term: &str,
            col_width: u32,
            row_height: u32,
            _pix_width: u32,
            _pix_height: u32,
            _modes: &[(russh::Pty, u32)],
            session: &mut ServerSession,
        ) -> Result<(), Self::Error> {
            self.recorded.lock().pty = Some((term.to_string(), col_width, row_height));
            session.channel_success(channel)
        }

        async fn window_change_request(
            &mut self,
            channel: russh::ChannelId,
            col_width: u32,
            row_height: u32,
            _pix_width: u32,
            _pix_height: u32,
            session: &mut ServerSession,
        ) -> Result<(), Self::Error> {
            self.recorded.lock().resizes.push((col_width, row_height));
            session.channel_success(channel)
        }

        async fn exec_request(
            &mut self,
            channel: russh::ChannelId,
            data: &[u8],
            session: &mut ServerSession,
        ) -> Result<(), Self::Error> {
            let command = String::from_utf8_lossy(data).to_string();
            self.recorded.lock().commands.push(command.clone());
            session.channel_success(channel)?;
            session.data(channel, b"ready\r\n".to_vec())?;
            // "keep-open" stands in for an interactive shell: it produces output
            // but never exits, so the client can exercise resize and keystrokes.
            // A login shell is the same kind of session, and is what a remote
            // side terminal runs.
            if command.contains("keep-open") || command.contains("-il") {
                return Ok(());
            }
            session.exit_status_request(channel, if command.contains("fail") { 3 } else { 0 })?;
            session.eof(channel)?;
            session.close(channel)
        }

        async fn data(
            &mut self,
            channel: russh::ChannelId,
            data: &[u8],
            session: &mut ServerSession,
        ) -> Result<(), Self::Error> {
            self.recorded.lock().received.extend_from_slice(data);
            session.data(channel, data.to_vec())
        }

        /// The client hangs a closing tab's job up. Recording it is what makes
        /// "a remote shell does not outlive its pane" a checked promise rather
        /// than an intention.
        async fn signal(
            &mut self,
            _channel: russh::ChannelId,
            signal: Sig,
            _session: &mut ServerSession,
        ) -> Result<(), Self::Error> {
            if matches!(signal, Sig::HUP) {
                self.recorded.lock().hung_up += 1;
            }
            Ok(())
        }
    }

    async fn start_server() -> (Target, Arc<Mutex<Recorded>>) {
        // Bind the socket here and hand the listener to the server, rather than probing
        // a free port and letting the server bind that number again. The probe only
        // reserves the port until it is dropped, and the connect below then races the
        // server's own bind: when it wins, the connection is refused and the test
        // reports that instead of the reason for it. A listener bound before the spawn
        // is already accepting, so there is no window to lose.
        let socket = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind a test port");
        let port = socket.local_addr().expect("test address").port();
        let config = Arc::new(russh::server::Config {
            keys: vec![russh::keys::PrivateKey::from_openssh(HOST_KEY).expect("test host key")],
            // Keep the default auth rejection delay out of the test's critical path.
            auth_rejection_time: Duration::from_millis(0),
            auth_rejection_time_initial: Some(Duration::from_millis(0)),
            ..Default::default()
        });
        let recorded = Arc::new(Mutex::new(Recorded::default()));
        let mut server = TestServer {
            recorded: recorded.clone(),
            id: 0,
        };
        tokio::spawn(async move {
            // A swallowed error here is what made a refused connection look like an
            // environment problem: say why the server stopped.
            if let Err(error) = server.run_on_socket(config, &socket).await {
                eprintln!("test ssh server stopped: {error}");
            }
        });
        let target = Target {
            id: format!("que-test-{port}"),
            hostname: "127.0.0.1".into(),
            user: "tester".into(),
            port,
            identity_file: None,
        };
        (target, recorded)
    }

    async fn wait_for(mut condition: impl FnMut() -> bool, what: &str) {
        for _ in 0..400 {
            if condition() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        panic!("timed out waiting for {what}");
    }

    /// The whole remote path against a real SSH server: host key trust, password
    /// authentication, connection reuse, an interactive pty with its exact size
    /// and later resizes, and one-shot exec with its exit status.
    ///
    /// One test rather than several because the known_hosts override is
    /// process-wide.
    #[tokio::test]
    async fn drives_a_real_ssh_session() {
        let (target, recorded) = start_server().await;
        let store = std::env::temp_dir().join(format!("que-known-hosts-{}", std::process::id()));
        let _ = std::fs::remove_file(&store);
        std::env::set_var("QUE_KNOWN_HOSTS", &store);

        // An unknown host key must stop, and hand back the fingerprint to confirm.
        let failure = match connect_target(&target, Some(PASSWORD.into()), None).await {
            Ok(_) => panic!("an unknown host key must not be trusted silently"),
            Err(error) => error,
        };
        let prompt = match failure {
            AppError::Machine { code, prompt, .. } => {
                assert_eq!(code, "HOST_TRUST_REQUIRED");
                prompt.expect("a trust prompt")
            }
            other => panic!("expected HOST_TRUST_REQUIRED, got {other:?}"),
        };
        assert!(
            prompt.contains("SHA256:"),
            "the prompt should carry the fingerprint: {prompt}"
        );

        // Accepting that exact prompt records the key and completes the connection.
        connect_target(&target, Some(PASSWORD.into()), Some(prompt))
            .await
            .expect("trusted connect");

        // Now it is pinned, so no prompt and no password are needed.
        connect_target(&target, None, None)
            .await
            .expect("reconnect from the pool");
        assert!(
            pool().lock().await.contains_key(&target.id),
            "the session should be pooled, not re-dialled"
        );

        // An interactive pty: the size the front end asked for is the size the
        // remote server sees, and a later resize is an explicit window-change
        // rather than a guess.
        let (queue, commands) = mpsc::unbounded_channel();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        let pty = {
            let target = target.clone();
            tokio::spawn(async move {
                run_pty_target(
                    &target,
                    "keep-open",
                    100,
                    30,
                    move |data: Vec<u8>| sink.lock().extend_from_slice(&data),
                    commands,
                )
                .await
            })
        };
        {
            let recorded = recorded.clone();
            wait_for(move || recorded.lock().pty.is_some(), "the pty request").await;
        }
        assert_eq!(
            recorded.lock().pty,
            Some(("xterm-256color".into(), 100, 30))
        );

        queue
            .send(PtyCommand::Resize(120, 40))
            .expect("send a resize");
        {
            let recorded = recorded.clone();
            wait_for(
                move || !recorded.lock().resizes.is_empty(),
                "the window change",
            )
            .await;
        }
        assert_eq!(recorded.lock().resizes, vec![(120, 40)]);

        queue
            .send(PtyCommand::Data(b"ping".into()))
            .expect("send keystrokes");
        {
            let recorded = recorded.clone();
            wait_for(
                move || recorded.lock().received.ends_with(b"ping"),
                "the keystrokes",
            )
            .await;
        }
        {
            let seen = seen.clone();
            wait_for(move || seen.lock().ends_with(b"ping"), "the echoed output").await;
        }

        queue.send(PtyCommand::Close).expect("close the session");
        assert_eq!(pty.await.expect("pty task").expect("pty run"), 0);

        // One-shot exec reuses the same connection.
        assert_eq!(
            exec_target(&target, "echo hi", &[]).await.expect("exec"),
            b"ready\r\n"
        );
        assert!(recorded
            .lock()
            .commands
            .iter()
            .any(|command| command == "echo hi"));

        // A non-zero exit status is an error, not a silently empty result.
        let failure = match exec_target(&target, "fail now", &[]).await {
            Ok(output) => panic!("a non-zero exit must error, got {output:?}"),
            Err(error) => error,
        };
        assert!(
            failure.to_string().contains('3'),
            "the exit status should reach the message: {failure}"
        );

        // A remote *side terminal*, driven through `TerminalHub` — the call the
        // card's terminal button makes, with the host arriving as the id the
        // front end sends. It has to resolve that id, ask the server for the size
        // the pane has, forward keystrokes, turn a resize into a window-change,
        // and hang the remote job up when the tab closes. No local pty and no
        // `ssh.exe` take part anywhere in it.
        let hosts =
            std::env::temp_dir().join(format!("que-remote-hosts-{}.json", std::process::id()));
        std::fs::write(
            &hosts,
            serde_json::to_string(&[crate::models::RemoteHost {
                id: target.id.clone(),
                name: "que test host".into(),
                hostname: target.hostname.clone(),
                user: Some(target.user.clone()),
                port: Some(target.port),
                identity_file: None,
                source: "web".into(),
                visible: None,
                connected: None,
            }])
            .expect("serialize the host Que resolves"),
        )
        .expect("write the host Que resolves");
        std::env::set_var("QUE_REMOTE_HOSTS", &hosts);

        let hub = crate::terminal::TerminalHub::new(crate::live::LiveBus::new());
        let side = "cccccccccccccccccccccccccccccccc";
        hub.create_remote_shell(
            "/srv/app".into(),
            132,
            43,
            Some(side.into()),
            target.id.clone(),
            true,
            Some("card1".into()),
        )
        .expect("start a remote side terminal");
        {
            let recorded = recorded.clone();
            wait_for(
                move || {
                    recorded
                        .lock()
                        .commands
                        .iter()
                        .any(|command| command.contains("/srv/app"))
                },
                "the remote login shell",
            )
            .await;
        }
        let raw_cmd = crate::ssh::remote_login_shell("/srv/app", crate::terminal_theme::app_dark());
        let expected = crate::ssh::ssh_login_command(&crate::ssh::wrap_remote_tmux(
            "card_card1_side_cccccccccccccccccccccccccccccccc",
            "/srv/app",
            &raw_cmd,
        ));
        assert!(recorded
            .lock()
            .commands
            .iter()
            .any(|command| command == &expected));
        assert_eq!(
            recorded.lock().pty,
            Some(("xterm-256color".into(), 132, 43))
        );

        assert!(hub.write(side, "echo hi\n"), "keystrokes reach the channel");
        {
            let recorded = recorded.clone();
            wait_for(
                move || recorded.lock().received.ends_with(b"echo hi\n"),
                "the keystrokes on the wire",
            )
            .await;
        }
        wait_for(
            || {
                hub.snapshot(side)
                    .is_some_and(|snapshot| snapshot.output.contains("echo hi"))
            },
            "the echoed output in the pane",
        )
        .await;

        assert!(hub.resize(side, 90, 50));
        {
            let recorded = recorded.clone();
            wait_for(
                move || recorded.lock().resizes.contains(&(90, 50)),
                "the window change",
            )
            .await;
        }

        // Closing the tab hangs the remote job up and drops the pane, rather than
        // leaving a shell running on the far machine with nothing attached to it.
        hub.kill(side);
        assert!(hub.snapshot(side).is_none(), "a closed pane is gone");
        {
            let recorded = recorded.clone();
            wait_for(
                move || recorded.lock().hung_up > 0,
                "the remote job to be hung up",
            )
            .await;
        }

        std::env::remove_var("QUE_REMOTE_HOSTS");
        std::env::remove_var("QUE_KNOWN_HOSTS");
        let _ = std::fs::remove_file(&hosts);
        let _ = std::fs::remove_file(&store);
    }

    /// A directory failure keeps its routing code but not at the cost of the
    /// remote's own words — the user needs the path, not just "目录读不了".
    #[test]
    fn a_directory_failure_carries_the_remote_text() {
        let error = exec_error(b"bash: cd: /srv/app: No such file or directory", 1);
        match error {
            AppError::Machine {
                code,
                detail: Some(detail),
                ..
            } => {
                assert_eq!(code, "DIRECTORY");
                assert!(
                    detail.contains("/srv/app"),
                    "the detail should carry the path: {detail}"
                );
            }
            other => panic!("expected DIRECTORY with detail, got {other:?}"),
        }
        // Unrelated stderr stays a raw message, which the UI already prints as-is.
        assert!(matches!(
            exec_error(b"some other failure", 7),
            AppError::Message(_)
        ));
        assert!(matches!(exec_error(b"", 3), AppError::Message(_)));
    }
}
