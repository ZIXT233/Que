use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

fn i64_from_json(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_u64().map(|n| n as i64))
        .or_else(|| value.as_f64().map(|n| n as i64))
}

fn deserialize_i64<'de, D>(deserializer: D) -> Result<i64, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    i64_from_json(&value).ok_or_else(|| serde::de::Error::custom("expected a number"))
}

fn deserialize_opt_i64<'de, D>(deserializer: D) -> Result<Option<i64>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Option::<Value>::deserialize(deserializer)?;
    Ok(match value {
        None | Some(Value::Null) => None,
        Some(value) => Some(i64_from_json(&value).unwrap_or(0)),
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub path: String,
    pub id: String,
    pub cwd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub created: String,
    pub modified: String,
    pub message_count: u64,
    pub first_message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CardPhase {
    Draft,
    Working,
    Attention,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueWorkspace {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub cwd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ssh_host: Option<String>,
    pub runtime_cwd: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_opt_i64"
    )]
    pub default_conversation_weight: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessSession {
    pub kind: String,
    pub terminal_id: String,
    pub state: String,
    #[serde(default)]
    pub version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_preview: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shell_command_notifications: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shell_command_started_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shell_command_running: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shell_notify: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shell_exit_code: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_session_id: Option<String>,
    /// Real session name (session file, or OpenCode OSC title).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_name: Option<String>,
    /// First user prompt from the session file when the name is empty.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_prompt: Option<String>,
    /// Last hooked submit on this card.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub submit_prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unpersisted_session: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub probe: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tmux: Option<bool>,
}

/// One message of an external session's own record, so a card can show the exchange
/// instead of only that the session is waiting.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExternalTurn {
    /// "user" or "assistant".
    pub role: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExternalNotice {
    /// Provider conversation id, or the workspace path when the CLI reports none.
    /// Stable for the life of one external session, so the card survives reloads.
    pub id: String,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// Last path segment of the workspace the external session is working in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    /// Full workspace directory, so the card can name the folder it is really in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    /// Real session title from the provider's own store, when it can be read.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_name: Option<String>,
    /// Latest user prompt, i.e. the ask whose turn just ended.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    /// Tail of the conversation, oldest first. Empty when only the hook reported it.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub turns: Vec<ExternalTurn>,
    /// "attention" while the session wants a human, "working" while it has the floor.
    pub state: String,
    /// The reply itself: a notice has no terminal, so this is the card's content.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notification: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    /// Manual weight for score ordering while this external notice is live.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority_weight: Option<i64>,
    /// First timestamp of the current attention wait; unchanged by repeated hooks.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub waiting_since: Option<i64>,
    /// When the session entered attention; drives ordering and the age label.
    pub at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetachedLease {
    pub owner: String,
    pub expires_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardSideTerminal {
    pub id: String,
    pub cwd: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueCard {
    pub id: String,
    pub cwd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub session: Option<SessionInfo>,
    pub phase: CardPhase,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub manual_placement: Option<ManualCardPlacement>,
    pub created_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ready_at: Option<i64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_opt_i64"
    )]
    pub priority_weight: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub waiting_since: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_key: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub urgent_call: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_tags: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tag_evaluation: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tag_history: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archived_at: Option<i64>,
    /// Unix ms deadline while the card is parked in "remind me later".
    /// None means the card is a normal queue card.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remind_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detached: Option<DetachedLease>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub side_terminals: Option<Vec<CardSideTerminal>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub side_terminal_open: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub harness: Option<HarnessSession>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_sources: Option<Value>,
}

/// Queue placement only; never alter the actual CLI state. Expires when that
/// state changes or a different terminal replaces the process.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualCardPlacement {
    pub background: bool,
    pub terminal_id: String,
    pub observed_state: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnTag {
    pub name: String,
    #[serde(default, deserialize_with = "deserialize_i64")]
    pub weight: i64,
    #[serde(default)]
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardQueue {
    pub version: u32,
    pub revision: u64,
    pub cards: Vec<QueueCard>,
    pub order: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_tags_enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sort_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_tag_definitions: Option<Vec<TurnTag>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub insertion_position: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspaces: Option<Vec<QueueWorkspace>>,
}

impl CardQueue {
    pub fn empty() -> Self {
        Self {
            version: 1,
            revision: 0,
            cards: vec![],
            order: vec![],
            turn_tags_enabled: Some(false),
            sort_mode: Some("score".into()),
            turn_tag_definitions: None,
            insertion_position: Some("bottom".into()),
            workspaces: Some(vec![]),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteHost {
    pub id: String,
    pub name: String,
    pub hostname: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    /// `IdentityFile` read out of `~/.ssh/config`. Que talks the SSH protocol
    /// itself now, so it has to find the key the user's config points at.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity_file: Option<String>,
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visible: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connected: Option<bool>,
}

fn default_powershell() -> bool {
    cfg!(windows)
}

fn default_developer_probes() -> bool {
    false
}

/// Every harness that serves sessions Que never launched under its own settings key
/// starts enabled; family members covered by their host's key are not listed.
fn default_external_ingress() -> std::collections::HashMap<String, bool> {
    crate::harness::registry::ALL
        .iter()
        .filter(|harness| harness.external_ingress())
        .map(|harness| (harness.id().to_string(), true))
        .collect()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSettings {
    #[serde(default = "default_powershell")]
    pub powershell_enabled: bool,
    #[serde(default = "default_developer_probes", alias = "developerProbes")]
    pub developer_probes: bool,
    /// Master gate for external-session notices. Off by default: the feature
    /// (and especially its jump-to-window action) is experimental and not
    /// reliable yet. Per-harness keys only apply while this is on.
    #[serde(default, alias = "externalNoticesEnabled")]
    pub external_notices_enabled: bool,
    #[serde(default = "default_external_ingress", alias = "externalIngress")]
    pub external_ingress: std::collections::HashMap<String, bool>,
}

impl AppSettings {
    pub fn is_external_ingress_enabled(&self, harness: &str) -> bool {
        if !self.external_notices_enabled {
            return false;
        }
        // Family members share their host's key: "gemini" toggles with "antigravity",
        // "omp" with "pi". The registry is the one place that mapping lives.
        let key = crate::harness::registry::find(harness)
            .map(|h| h.ingress_key())
            .unwrap_or(harness);
        self.external_ingress.get(key).copied().unwrap_or(true)
    }
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            powershell_enabled: default_powershell(),
            developer_probes: default_developer_probes(),
            external_notices_enabled: false,
            external_ingress: default_external_ingress(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_float_weights_from_queue_json() {
        let raw = r#"{
            "version": 1,
            "revision": 1,
            "cards": [{
                "id": "c1",
                "cwd": "/",
                "phase": "draft",
                "createdAt": 1,
                "priorityWeight": 0.0
            }],
            "order": [],
            "workspaces": [{
                "id": "w1",
                "name": "Home",
                "kind": "local",
                "cwd": "/",
                "runtimeCwd": "/",
                "defaultConversationWeight": 0.0
            }]
        }"#;
        let queue: CardQueue = serde_json::from_str(raw).unwrap();
        assert_eq!(queue.cards[0].priority_weight, Some(0));
        assert_eq!(
            queue.workspaces.unwrap()[0].default_conversation_weight,
            Some(0)
        );
    }

    #[test]
    fn powershell_defaults_on_windows_only() {
        let missing: AppSettings = serde_json::from_str("{}").unwrap();
        assert_eq!(missing.powershell_enabled, cfg!(windows));
        let explicit: AppSettings =
            serde_json::from_str(r#"{"powershell_enabled":false}"#).unwrap();
        assert!(!explicit.powershell_enabled);
        assert_eq!(AppSettings::default().powershell_enabled, cfg!(windows));
        assert!(!missing.developer_probes);
        let off: AppSettings = serde_json::from_str(r#"{"developer_probes":false}"#).unwrap();
        assert!(!off.developer_probes);
        let on: AppSettings = serde_json::from_str(r#"{"developer_probes":true}"#).unwrap();
        assert!(on.developer_probes);
        let camel: AppSettings = serde_json::from_str(r#"{"developerProbes":true}"#).unwrap();
        assert!(camel.developer_probes);
        // Master gate off by default: a settings file without the key (and one
        // with only per-harness keys) gates every harness off.
        assert!(!missing.is_external_ingress_enabled("codex"));
        assert!(!missing.is_external_ingress_enabled("cursor"));
        assert!(!missing.is_external_ingress_enabled("antigravity"));
        assert!(!missing.is_external_ingress_enabled("gemini"));

        let disabled: AppSettings =
            serde_json::from_str(r#"{"external_ingress":{"codex":false}}"#).unwrap();
        assert!(!disabled.is_external_ingress_enabled("codex"));
        assert!(!disabled.is_external_ingress_enabled("cursor"));

        // With the gate on, per-harness keys apply: absent means enabled.
        let on: AppSettings = serde_json::from_str(
            r#"{"external_notices_enabled":true,"external_ingress":{"codex":false}}"#,
        )
        .unwrap();
        assert!(!on.is_external_ingress_enabled("codex"));
        assert!(on.is_external_ingress_enabled("cursor"));
        // The gate overrides even an explicit per-harness true.
        let gated: AppSettings = serde_json::from_str(
            r#"{"external_notices_enabled":false,"external_ingress":{"codex":true}}"#,
        )
        .unwrap();
        assert!(!gated.is_external_ingress_enabled("codex"));
        let camel: AppSettings =
            serde_json::from_str(r#"{"externalNoticesEnabled":true}"#).unwrap();
        assert!(camel.is_external_ingress_enabled("codex"));
    }
}
