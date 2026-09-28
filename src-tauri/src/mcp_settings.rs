//! Discoverable settings facade. Uses the same services as the UI.
use crate::{
    api::AppState,
    error::{AppError, AppResult},
};
use axum::Json;
use serde_json::{json, Value};
static PREF_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
fn required<'a>(v: &'a Value, key: &str) -> AppResult<&'a str> {
    v[key]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::msg(format!("Missing {key}")))
}
fn ui_catalog() -> Value {
    serde_json::from_str(include_str!("../../resources/settings-catalog.json")).unwrap()
}
fn valid(value: &Value, schema: &Value) -> bool {
    let kind = match schema["type"].as_str() {
        Some("string") => value.is_string(),
        Some("boolean") => value.is_boolean(),
        Some("number") => value.as_f64().is_some_and(|n| {
            n.is_finite()
                && n.fract() == 0.0
                && n >= schema["minimum"].as_f64().unwrap_or(f64::MIN)
                && n <= schema["maximum"].as_f64().unwrap_or(f64::MAX)
        }),
        Some("object") => value.as_object().is_some_and(|items| {
            items
                .iter()
                .all(|(k, v)| schema["properties"].get(k).is_some_and(|s| valid(v, s)))
                && schema["properties"]
                    .as_object()
                    .unwrap()
                    .keys()
                    .all(|k| items.contains_key(k))
        }),
        _ => false,
    };
    kind && schema["enum"]
        .as_array()
        .is_none_or(|choices| choices.contains(value))
}
fn read_preferences() -> AppResult<Value> {
    let file = crate::paths::data_dir().join("preferences.json");
    match std::fs::read(file) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(e) => Err(e.into()),
    }
}
fn validate_patch(patch: &Value) -> AppResult<()> {
    let items = patch
        .as_object()
        .ok_or_else(|| AppError::msg("patch must be an object"))?;
    let catalog = ui_catalog();
    for (k, v) in items {
        if !catalog.get(k).is_some_and(|s| valid(v, s)) {
            return Err(AppError::msg(format!("Invalid setting: {k}")));
        }
    }
    Ok(())
}
pub async fn get_preferences() -> AppResult<Json<Value>> {
    Ok(Json(read_preferences()?))
}
pub async fn put_preferences(Json(body): Json<Value>) -> AppResult<Json<Value>> {
    validate_patch(&body["patch"])?;
    let _lock = PREF_LOCK.lock().await;
    let mut values = read_preferences()?;
    if let Some(expected) = body.get("expected").filter(|v| !v.is_null()) {
        for (k, v) in expected
            .as_object()
            .ok_or_else(|| AppError::msg("expected must be object"))?
        {
            if values.get(k) != Some(v) {
                return Err(AppError::msg(format!("Setting changed; read again: {k}")));
            }
        }
    }
    for (k, v) in body["patch"].as_object().unwrap() {
        if body["onlyMissing"] != true || values.get(k).is_none() {
            values[k] = v.clone();
        }
    }
    std::fs::create_dir_all(crate::paths::data_dir())?;
    crate::paths::atomic_write(
        &crate::paths::data_dir().join("preferences.json"),
        &serde_json::to_string_pretty(&values)?,
    )?;
    Ok(Json(values))
}
pub fn catalog() -> Value {
    json!({
     "ui":ui_catalog(),
     "app":{"fields":{"debugLogging":"boolean","powerShellEnabled":"boolean"},"apply":"debug logging immediately; PowerShell affects subsequent launches"},
     "speech":{"fields":{"language":["auto","zh","en"],"apiKey":"write-only string; omit to preserve, empty to clear"}},
     "queue":{"fields":{"sortMode":["fifo","score"],"insertionPosition":["top","bottom"],"turnTagsEnabled":"boolean","turnTags":"array of {name:string,weight:integer,description:string}; replaces all tag definitions"},"note":"Changing sortMode resets insertionPosition to bottom unless supplied in the same patch"},
     "workspace":{"target":"workspaceId","fields":{"name":"nonempty string","defaultConversationWeight":"number"}},
     "machine":{"target":"machineKey: local or ssh:<host>","fields":{"terminalRc":"string (write-only)","sessionEnv":"object; replaces the environment map; values redacted on read"},"apply":"new sessions/terminals"},
     "remote":{"tools":["list_remote_hosts","configure_remote_host"]},
     "workspaceCreation":{"tool":"create_workspace","directory":"must already exist"},
     "excluded":["OS microphone/notification permissions and SSH host trust require the system UI","MCP authorization grants remain in the existing authorization flow","live model/permission controls belong to their ACP session, not global settings"],
     "access":"Settings tools require a live all-card Agent; Butler qualifies. Change only user-requested settings."
    })
}
pub async fn read(state: &AppState, body: &Value) -> AppResult<Value> {
    let queue = state.queue.read_snapshot()?;
    match required(body, "scope")? {
        "ui" => Ok(
            json!({"values":read_preferences()?,"defaults":ui_catalog(),"apply":"UI synchronizes within 1.5 seconds"}),
        ),
        "app" => {
            let s = state.settings.read()?;
            Ok(json!({"debugLogging":s.developer_probes,"powerShellEnabled":s.powershell_enabled}))
        }
        "speech" => Ok(crate::speech::settings().await?.0),
        "queue" => Ok(
            json!({"sortMode":queue.sort_mode,"insertionPosition":queue.insertion_position,"turnTagsEnabled":queue.turn_tags_enabled,"turnTags":queue.turn_tag_definitions}),
        ),
        "workspace" => {
            let id = required(body, "target")?;
            let w = queue
                .workspaces
                .as_ref()
                .and_then(|ws| ws.iter().find(|w| w.id == id))
                .ok_or_else(|| AppError::msg("Workspace not found"))?;
            Ok(
                json!({"workspaceId":w.id,"name":w.name,"cwd":w.cwd,"kind":w.kind,"sshHost":w.ssh_host,"defaultConversationWeight":w.default_conversation_weight}),
            )
        }
        "machine" => {
            let key = required(body, "target")?;
            let s = queue.machine_settings.get(key);
            Ok(
                json!({"machineKey":key,"terminalRcConfigured":s.and_then(|s|s.terminal_rc.as_ref()).is_some(),"environmentKeys":s.map(|s|s.session_env.keys().collect::<Vec<_>>()).unwrap_or_default()}),
            )
        }
        _ => Err(AppError::msg("Unknown settings scope; use list_settings")),
    }
}
fn allowed(patch: &Value, keys: &[&str]) -> AppResult<()> {
    let p = patch
        .as_object()
        .ok_or_else(|| AppError::msg("patch must be object"))?;
    if p.is_empty() || p.keys().any(|k| !keys.contains(&k.as_str())) {
        return Err(AppError::msg("Unsupported or empty settings patch"));
    }
    Ok(())
}
pub async fn update(state: &AppState, body: &Value) -> AppResult<Value> {
    let patch = &body["patch"];
    let scope = required(body, "scope")?;
    if scope == "ui" {
        return Ok(
            put_preferences(Json(json!({"patch":patch,"expected":body.get("expected")})))
                .await?
                .0,
        );
    }
    if body.get("expected").is_some() {
        return Err(AppError::msg(
            "expected is supported for UI preferences only",
        ));
    }
    match scope {
        "app" => {
            allowed(patch, &["debugLogging", "powerShellEnabled"])?;
            for (_, v) in patch.as_object().unwrap() {
                if !v.is_boolean() {
                    return Err(AppError::msg("Expected boolean"));
                }
            }
            if let Some(v) = patch["debugLogging"].as_bool() {
                state.settings.set_debug_logging(v).await?;
            }
            if let Some(v) = patch["powerShellEnabled"].as_bool() {
                state.settings.set_powershell(v).await?;
            }
        }
        "speech" => {
            allowed(patch, &["language", "apiKey"])?;
            let _ =
                crate::speech::save_settings(Json(serde_json::from_value(patch.clone())?)).await?;
        }
        "workspace" | "machine" | "queue" => {
            let mut actions = Vec::new();
            match scope {
                "workspace" => {
                    allowed(patch, &["name", "defaultConversationWeight"])?;
                    if patch.get("name").is_some_and(|v| !v.is_string())
                        || patch
                            .get("defaultConversationWeight")
                            .is_some_and(|v| !v.is_number())
                    {
                        return Err(AppError::msg("Invalid workspace settings"));
                    }
                    let current = read(state, body).await?;
                    let mut action = json!({"action":"workspace_update","workspaceId":required(body,"target")?,"name":current["name"],"defaultConversationWeight":current["defaultConversationWeight"]});
                    for (k, v) in patch.as_object().unwrap() {
                        action[k] = v.clone();
                    }
                    actions.push(action);
                }
                "machine" => {
                    allowed(patch, &["terminalRc", "sessionEnv"])?;
                    let q = state.queue.read_snapshot()?;
                    let key = required(body, "target")?;
                    let current = q.machine_settings.get(key);
                    actions.push(json!({"action":"machine_settings_update","machineKey":key,"terminalRc":patch.get("terminalRc").cloned().unwrap_or(json!(current.and_then(|s|s.terminal_rc.as_deref()).unwrap_or(""))),"sessionEnv":patch.get("sessionEnv").cloned().unwrap_or(json!(current.map(|s|&s.session_env).cloned().unwrap_or_default()))}));
                }
                _ => {
                    allowed(
                        patch,
                        &[
                            "sortMode",
                            "insertionPosition",
                            "turnTagsEnabled",
                            "turnTags",
                        ],
                    )?;
                    if patch
                        .get("turnTagsEnabled")
                        .is_some_and(|v| !v.is_boolean())
                    {
                        return Err(AppError::msg("turnTagsEnabled must be boolean"));
                    }
                    if let Some(tags) = patch.get("turnTags") {
                        let _: Vec<crate::models::TurnTag> = serde_json::from_value(tags.clone())?;
                    }
                    for (key, action, field) in [
                        ("sortMode", "sort_mode", "mode"),
                        ("insertionPosition", "insertion_position", "position"),
                        ("turnTagsEnabled", "turn_tags_enabled", "enabled"),
                        ("turnTags", "turn_tags", "tags"),
                    ] {
                        if let Some(v) = patch.get(key) {
                            let mut a = json!({"action":action});
                            a[field] = v.clone();
                            actions.push(a);
                        }
                    }
                }
            }
            // Validate and apply the whole patch under the existing queue lock. A failure
            // discards the candidate rather than partially committing multiple fields.
            state
                .queue
                .with_queue(false, |q| {
                    let mut candidate = q.clone();
                    for action in &actions {
                        let mut a = action.clone();
                        if scope == "workspace" {
                            if let Some(w) = candidate.workspaces.as_ref().and_then(|ws| {
                                ws.iter()
                                    .find(|w| Some(w.id.as_str()) == body["target"].as_str())
                            }) {
                                if patch.get("name").is_none() {
                                    a["name"] = json!(w.name);
                                }
                                if patch.get("defaultConversationWeight").is_none() {
                                    a["defaultConversationWeight"] =
                                        json!(w.default_conversation_weight);
                                }
                            }
                        }
                        if scope == "machine" {
                            let current = candidate
                                .machine_settings
                                .get(body["target"].as_str().unwrap_or(""));
                            if patch.get("terminalRc").is_none() {
                                a["terminalRc"] = json!(current
                                    .and_then(|s| s.terminal_rc.as_deref())
                                    .unwrap_or(""));
                            }
                            if patch.get("sessionEnv").is_none() {
                                a["sessionEnv"] = json!(current
                                    .map(|s| s.session_env.clone())
                                    .unwrap_or_default());
                            }
                        }
                        crate::api::apply_action(
                            &mut candidate,
                            &a,
                            a["action"].as_str().unwrap(),
                            state,
                        )?;
                    }
                    *q = candidate;
                    Ok(())
                })
                .await?;
        }
        _ => return Err(AppError::msg("Unknown settings scope")),
    }
    read(state, body).await
}
pub async fn create_workspace(state: &AppState, body: &Value) -> AppResult<Value> {
    let kind = required(body, "kind")?;
    if !["local", "ssh"].contains(&kind) || required(body, "name")?.trim().is_empty() {
        return Err(AppError::msg("Invalid workspace kind or name"));
    }
    if kind == "local" && body.get("sshHost").is_some_and(|v| !v.is_null()) {
        return Err(AppError::msg("sshHost is only valid for SSH workspaces"));
    }
    let mut request = body.clone();
    request["action"] = json!("workspace_create");
    request["createCard"] = json!(false);
    crate::api::normalize_workspace_create(&mut request).await?;
    if request["kind"] == "local" {
        request["cwd"] = json!(
            crate::paths::ordinary_windows_path(crate::paths::expand_user(
                required(&request, "cwd")?.trim()
            ))
            .to_string_lossy()
        );
    }
    state.queue.with_queue(false,|q|{
   let matches=|w:&&crate::models::QueueWorkspace| w.cwd==request["cwd"].as_str().unwrap_or("")&&w.kind==request["kind"].as_str().unwrap_or("")&&w.ssh_host.as_deref()==request["sshHost"].as_str();
   let existing=q.workspaces.as_ref().and_then(|ws|ws.iter().find(matches)).cloned();
   let replayed=existing.is_some();
   let w=if let Some(w)=existing{w}else{
     crate::api::apply_action(q,&request,"workspace_create",state)?;
     q.workspaces.as_ref().and_then(|ws|ws.iter().find(matches)).cloned().ok_or_else(||AppError::msg("Workspace not found after creation"))?
   };
   Ok(json!({"workspaceId":w.id,"name":w.name,"cwd":w.cwd,"kind":w.kind,"sshHost":w.ssh_host,"alreadyExists":replayed}))
 }).await
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preferences_validate_before_writing() {
        assert!(validate_patch(&json!({"theme":"dark","fontSize":18})).is_ok());
        for p in [
            json!({"theme":"arbitrary"}),
            json!({"fontSize":999}),
            json!({"fontSize":12.2}),
            json!({"apiKey":"secret"}),
            json!({"soundEnabled":"true"}),
            json!({"terminalAppearance":{"font":"inject"}}),
        ] {
            assert!(validate_patch(&p).is_err());
        }
    }
}
