use crate::cwd::{browse, pick_local_folder};
use crate::error::{AppError, AppResult};
use crate::acp::AcpRuntime;
use crate::hosts::HostStore;
use crate::live::LiveBus;
use crate::models::{CardQueue, RemoteHost};
use crate::paste::{
    save_terminal_files, save_terminal_images, terminal_image_paste, validate_terminal_files,
    validate_terminal_images,
};
use crate::paths::{resolve_bin_dir, ssh_runtime_dir};
use crate::queue::{
    archive_card, move_card, now_ms, numeric_weight, park_remind, release_remind,
    sync_queue, QueueStore, TAB_LEASE_MS,
};
use crate::settings::SettingsStore;
use crate::ssh::{connect_host, shell_quote, ssh_exec, test_target};
use crate::terminal::{TerminalEvent, TerminalHub};
use axum::extract::{DefaultBodyLimit, FromRequest, Multipart, Path, Query, Request, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use futures::stream;
use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::convert::Infallible;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio_stream::wrappers::{BroadcastStream, UnboundedReceiverStream};
use tokio_stream::StreamExt;
use tower_http::cors::{AllowOrigin, Any, CorsLayer};
use uuid::Uuid;

#[derive(Clone)]
pub struct AppState {
    pub queue: Arc<QueueStore>,
    pub terminals: TerminalHub,
    pub harness: AcpRuntime,
    /// Attention notices from sessions Que did not launch. Read-only overlay data:
    /// never part of the queue store, never persisted.
    pub hosts: Arc<HostStore>,
    pub settings: Arc<SettingsStore>,
    pub live: LiveBus,
    pub bin_dir: PathBuf,
    pub default_cwd: PathBuf,
    pub launches: Arc<Mutex<HashSet<String>>>,
    pub mcp: Arc<crate::mcp::McpControl>,
    /// Proof that a request comes from Que's own windows; see `require_token`.
    pub api_token: Arc<str>,
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/mcp/config", get(crate::mcp::config))
        .route(
            "/api/mcp/tools",
            post(crate::mcp::tools).layer(DefaultBodyLimit::max(64 * 1024)),
        )
        .route("/api/acp/{id}", get(acp_read).post(acp_action))
        .route("/api/acp/events", get(acp_all_events))
        .route("/api/speech/settings", get(crate::speech::settings).put(crate::speech::save_settings))
        .route("/api/speech/transcribe", post(crate::speech::transcribe).layer(DefaultBodyLimit::max(10_100_000)))
        .route("/api/acp-catalog", get(acp_catalog))
        .route("/api/acp-history", get(acp_history).post(acp_history_open))
        .route("/api/card-queue", get(get_queue).post(post_queue))
        .route("/api/card-queue/bootstrap", get(bootstrap_queue))
        .route("/api/card-queue/events", get(queue_events))
        .route(
            "/api/workspace-machines",
            get(list_machines).post(machine_action),
        )
        .route("/api/cwd/browse", get(browse_cwd))
        .route("/api/preferences", get(crate::mcp_settings::get_preferences).put(crate::mcp_settings::put_preferences))
        .route("/api/tools/settings", get(get_tools).put(put_tools))
        .route("/api/logs", get(get_logs).post(post_log))
        .route(
            "/api/logs/report",
            get(get_log_report).post(export_log_report),
        )
        .route("/api/harness/{id}/debug", get(harness_debug))
        .route("/api/extensions/harnesses", get(extension_harnesses).post(reload_extensions))
        .route(
            "/api/terminal-theme",
            get(get_terminal_theme).post(set_terminal_theme),
        )
        .route("/api/terminal", post(create_terminal))
        .route(
            "/api/terminal/{id}",
            get(get_terminal)
                .post(post_terminal)
                .delete(delete_terminal),
        )
        .route("/api/terminal/{id}/events", get(terminal_events))
        .route("/api/sessions", get(empty_sessions))
        .layer(DefaultBodyLimit::max(110 * 1024 * 1024))
        .layer(axum::middleware::from_fn_with_state(state.clone(), require_token))
        .layer(
            CorsLayer::new()
                .allow_origin(AllowOrigin::predicate(|origin, _| own_origin(origin.as_bytes())))
                .allow_methods(Any)
                .allow_headers(Any),
        )
        .with_state(state)
}

/// The API listens on loopback, where any process — and any web page, through
/// the user's browser — can reach it. Its reads and writes reach the agents, so
/// every request must carry the token that only Que's own windows are given
/// (Tauri's `api_access`): as `x-que-token`, or as `token=` in the query where a
/// header cannot be set (EventSource, sendBeacon). The MCP endpoint keeps its
/// own bearer token, handed only to the agents Que launches.
async fn require_token(State(state): State<AppState>, request: Request, next: axum::middleware::Next) -> axum::response::Response {
    let path = request.uri().path();
    if !path.starts_with("/api/") || path == "/api/mcp/tools" {
        return next.run(request).await;
    }
    let token = &*state.api_token;
    let header = request.headers().get("x-que-token").and_then(|value| value.to_str().ok());
    let query = request.uri().query().and_then(|query| query.split('&').find_map(|pair| pair.strip_prefix("token=")));
    if header == Some(token) || query == Some(token) {
        next.run(request).await
    } else {
        (StatusCode::UNAUTHORIZED, Json(json!({"error": "Que API token required"}))).into_response()
    }
}

/// Que's windows (tauri://localhost on macOS and Linux, http(s)://tauri.localhost
/// on Windows) and a development server on this machine.
fn own_origin(origin: &[u8]) -> bool {
    let origin = std::str::from_utf8(origin).unwrap_or_default();
    matches!(origin, "tauri://localhost" | "http://tauri.localhost" | "https://tauri.localhost")
        || ["http://localhost:", "http://127.0.0.1:"].iter().any(|prefix| origin.strip_prefix(prefix).is_some_and(|port| port.parse::<u16>().is_ok()))
}

fn overlay_harness(queue: &mut CardQueue, state: &AppState) {
    let workspaces = queue.workspaces.as_ref().map(|items| items.iter()
        .map(|workspace| crate::workspace_rc::effective_workspace(queue, workspace))
        .collect::<Vec<_>>());
    for card in &mut queue.cards {
        let Some(session) = card.harness.take() else {
            continue;
        };
        let refresh = card.archived_at.is_none() || session.provider_session_id.is_none();
        card.harness = Some(if refresh {
            state.harness.snapshot(&session, &state.terminals, workspaces.as_ref().and_then(|ws| ws.iter().find(|w| Some(&w.id) == card.workspace_id.as_ref())))
        } else {
            session
        });
    }
}

fn refresh_queue(queue: &mut CardQueue, state: &AppState) {
    overlay_harness(queue, state);
    sync_queue(queue, &state.terminals);
}

async fn bootstrap_queue(State(state): State<AppState>) -> AppResult<impl IntoResponse> {
    Ok(Json(with_cwd(state.queue.read_snapshot()?, &state)))
}

async fn get_queue(State(state): State<AppState>) -> AppResult<impl IntoResponse> {
    let queue = state
        .queue
        .with_queue(true, |queue| {
            refresh_queue(queue, &state);
            Ok(queue.clone())
        })
        .await?;
    Ok(Json(with_cwd(queue, &state)))
}

pub(crate) async fn post_queue(
    State(state): State<AppState>,
    Json(mut body): Json<Value>,
) -> AppResult<Json<Value>> {
    let action = body
        .get("action")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    if action == "workspace_rc_verify" {
        let queue = state.queue.read_snapshot()?;
        let mut workspace = if let Some(key) = body["machineKey"].as_str() {
            let (kind, ssh_host, cwd) = if key == "local" {
                ("local", None, state.default_cwd.to_string_lossy().into_owned())
            } else if let Some(host) = key.strip_prefix("ssh:").filter(|host| valid_ssh_host(host)) {
                ("ssh", Some(host.to_string()), "/".into())
            } else {
                return Err(AppError::msg("Invalid machine"));
            };
            let workspace = queue.workspaces.as_ref().and_then(|items| items.iter()
                .find(|workspace| crate::workspace_rc::machine_key(workspace) == key))
                .cloned().unwrap_or(crate::models::QueueWorkspace {
                    id: String::new(), name: String::new(), kind: kind.into(),
                    runtime_cwd: cwd.clone(), cwd, ssh_host,
                    terminal_rc: None, session_env: Default::default(), default_conversation_weight: None,
                });
            crate::workspace_rc::effective_workspace(&queue, &workspace)
        } else {
            return Err(AppError::msg("Machine required"));
        };
        workspace.terminal_rc = Some(body["terminalRc"].as_str().unwrap_or_default().into());
        workspace.session_env = crate::workspace_rc::validate_session_env(
            body.get("sessionEnv").ok_or_else(|| AppError::msg("Session environment required"))?
        )?;
        return Ok(Json(crate::workspace_rc::verify(&workspace).await?));
    }
    if matches!(
        action.as_str(),
        "harness_start" | "harness_resume"
    ) {
        return launch_harness(&state, &body, &action)
            .await
            .map(|queue| Json(with_cwd(queue, &state)));
    }
    // Archive and startup share admission so a background reconnect cannot
    // slip between closing the agent and committing the archived card.
    let _lifecycle_guard = if matches!(action.as_str(), "archive" | "harness_close" | "remove") {
        body["id"].as_str().map(|id| try_acquire_launch(&state, id)).transpose()?
    } else { None };
    if matches!(action.as_str(), "archive" | "harness_close" | "remove") {
        if let Some(id) = body["id"].as_str() {
            let queue = state.queue.read_snapshot()?;
            if let Some(card) = queue.cards.iter().find(|c| c.id == id && c.harness.is_some()) {
                if card.detached.is_some() { return Err(AppError::msg("请先收回卡片")); }
                let ws = acp_workspace(&state, id).await?;
                let current = state.harness.request(&ws, &state.bin_dir, json!({"action":"read","id":id})).await?;
                if current["turns"].as_array().is_some_and(|turns| turns.iter().any(|t| matches!(t["state"].as_str(), Some("running" | "queued" | "cancelling")))) {
                    return Err(AppError::msg("请先停止或等待当前消息结束"));
                }
                if current["state"] != "not_running" { state.harness.request(&ws, &state.bin_dir, json!({"action":"close","id":id})).await?; }
            }
        }
    }
    if action == "workspace_create" { normalize_workspace_create(&mut body).await?; }
    let (queue, created) = state
        .queue
        .with_queue(false, |queue| {
            refresh_queue(queue, &state);
            let created = apply_action(queue, &body, &action, &state)?;
            refresh_queue(queue, &state);
            Ok((queue.clone(), created))
        })
        .await?;
    let mut queue = with_cwd(queue, &state);
    if let Some(id) = created { queue["createdId"] = json!(id); }
    Ok(Json(queue))
}

pub(crate) async fn normalize_workspace_create(body: &mut Value) -> AppResult<()> {
    if body.get("kind").and_then(|v| v.as_str()) == Some("ssh") {
        let host = body
            .get("sshHost")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let cwd_in = body
            .get("cwd")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if regex::Regex::new(r"^[a-zA-Z0-9][a-zA-Z0-9._@:-]*$")
            .unwrap()
            .is_match(&host)
            && cwd_in.starts_with('/')
        {
            crate::debuglog::debug(
                "api",
                &format!("workspace_create validate host={host:?} cwd={cwd_in:?}"),
            );
            let resolved =
                match ssh_exec(&host, &format!("cd {} && pwd -P", shell_quote(&cwd_in))).await {
                    Ok(output) => {
                        crate::debuglog::debug(
                            "api",
                            &format!(
                                "workspace_create pwd={:?}",
                                String::from_utf8_lossy(&output).trim()
                            ),
                        );
                        String::from_utf8_lossy(&output).trim().to_string()
                    }
                    Err(error) => {
                        crate::debuglog::log_error(
                            &format!("api: workspace_create validation FAILED host={host:?}"),
                            &error,
                        );
                        return Err(error);
                    }
                };
            if resolved.starts_with('/') {
                if let Some(obj) = body.as_object_mut() {
                    obj.insert("cwd".into(), json!(resolved));
                }
            } else {
                return Err(AppError::machine("REMOTE_CWD_UNRESOLVABLE"));
            }
        }
    }
    Ok(())
}

pub(crate) async fn acp_workspace(state: &AppState, id: &str) -> AppResult<crate::models::QueueWorkspace> {
    let queue = state.queue.read_snapshot()?;
    let card = queue.cards.iter().find(|c| c.id == id).ok_or_else(|| AppError::msg("卡片不存在"))?;
    let ws = queue.workspaces.as_ref().and_then(|ws| ws.iter().find(|w| Some(&w.id) == card.workspace_id.as_ref())).ok_or_else(|| AppError::msg("工作区不存在"))?;
    Ok(crate::workspace_rc::effective_workspace(&queue, ws))
}
async fn acp_catalog(State(state): State<AppState>, Query(query): Query<std::collections::HashMap<String,String>>) -> AppResult<Json<Value>> {
    let ws = if let Some(id) = query.get("workspace") { history_workspace(&state, id)? } else if let Some(id) = query.get("card") {
        acp_workspace(&state, id).await?
    } else { history_local_machine(&state)? };
    Ok(Json(state.harness.request(&ws, &state.bin_dir, json!({"action":"catalog"})).await?))
}
fn history_workspace(state: &AppState, id: &str) -> AppResult<crate::models::QueueWorkspace> {
    let queue=state.queue.read_snapshot()?;
    let workspace=queue.workspaces.as_ref().and_then(|items| items.iter().find(|w|w.id==id)).ok_or_else(||AppError::msg("工作区不存在"))?;
    Ok(crate::workspace_rc::effective_workspace(&queue,workspace))
}
fn history_local_machine(state: &AppState) -> AppResult<crate::models::QueueWorkspace> {
    let queue=state.queue.read_snapshot()?;
    let cwd=state.default_cwd.to_string_lossy().into_owned();
    let ws=crate::models::QueueWorkspace { id:String::new(),name:String::new(),kind:"local".into(),cwd:cwd.clone(),runtime_cwd:cwd,ssh_host:None,terminal_rc:None,session_env:Default::default(),default_conversation_weight:None };
    Ok(crate::workspace_rc::effective_workspace(&queue,&ws))
}
async fn acp_history(State(state): State<AppState>, Query(query): Query<std::collections::HashMap<String,String>>) -> AppResult<Json<Value>> {
    let ws=if let Some(id)=query.get("workspace") {history_workspace(&state,id)?} else if query.contains_key("agent") {history_local_machine(&state)?} else {return Err(AppError::msg("请选择工作区"));};
    let mut entries=state.harness.request(&ws,&state.bin_dir,json!({"action":if query.contains_key("agent") {"history_native"} else {"history"},"cwd":ws.cwd,"agent":query.get("agent"),"allWorkspaces":!query.contains_key("workspace"),"cursor":query.get("cursor"),"env":ws.session_env})).await?;
    let queue=state.queue.read_snapshot()?;
    let items = if entries.is_array() { entries.as_array_mut() } else { entries.get_mut("sessions").and_then(Value::as_array_mut) };
    if let Some(items)=items {
        items.retain(|entry| !queue.cards.iter().any(|card| card.archived_at.is_none() && card.harness.is_some() && entry["cardId"].as_str()==Some(card.id.as_str())));
    }
    Ok(Json(entries))
}
async fn acp_history_open(State(state): State<AppState>, Json(body): Json<Value>) -> AppResult<Json<Value>> {
    let ws=if let Some(id)=body["workspaceId"].as_str() {history_workspace(&state,id)?} else {
        let cwd=body["cwd"].as_str().filter(|p|std::path::Path::new(p).is_absolute()).ok_or_else(||AppError::msg("会话没有有效的工作目录"))?;
        let name=std::path::Path::new(cwd).file_name().and_then(|n|n.to_str()).unwrap_or(cwd);
        state.queue.with_queue(false,|queue| {
            apply_action(queue,&json!({"action":"workspace_create","kind":"local","cwd":cwd,"name":name}),"workspace_create",&state)?;
            Ok(())
        }).await?;
        let queue=state.queue.read_snapshot()?;
        let ws=queue.workspaces.as_ref().and_then(|ws|ws.iter().find(|w|w.kind=="local"&&w.cwd==cwd)).ok_or_else(||AppError::msg("工作区关联失败"))?;
        crate::workspace_rc::effective_workspace(&queue,ws)
    };
    let snapshot=state.harness.request(&ws,&state.bin_dir,json!({"action":"attach","id":uuid::Uuid::new_v4().to_string(),"recordId":body["recordId"],"nativeSessionId":body["nativeSessionId"],"agent":body["agent"],"title":body["title"],"env":ws.session_env,"cwd":ws.cwd})).await?;
    let id=snapshot["id"].as_str().ok_or_else(||AppError::msg("会话关联失败"))?.to_string();
    state.queue.with_queue(false,|queue| {
        if !queue.cards.iter().any(|c|c.id==id) {
            let card:crate::models::QueueCard=serde_json::from_value(json!({"id":id,"cwd":ws.runtime_cwd,"workspaceId":ws.id,"phase":"attention","createdAt":crate::queue::now_ms(),"archivedAt":crate::queue::now_ms(),"session":null,"harness":{"kind":snapshot["agent"],"terminalId":id,"state":"not_running","remote":ws.kind=="ssh"}}))?;
            queue.cards.push(card);
        }
        Ok(())
    }).await?;
    let queue=state.queue.read_snapshot()?;
    let card=queue.cards.iter().find(|card|card.id==id).ok_or_else(||AppError::msg("卡片不存在"))?;
    if card.archived_at.is_some() || !state.harness.is_live(&id) {
        launch_harness(&state,&json!({"id":id}),"harness_resume").await?;
    }
    Ok(Json(json!({"cardId":id})))
}
async fn acp_read(State(state): State<AppState>, Path(id): Path<String>) -> AppResult<Json<Value>> {
    let ws = acp_workspace(&state, &id).await?;
    Ok(Json(state.harness.request(&ws, &state.bin_dir, json!({"action":"read","id":id})).await?))
}
/// Every connected conversation on one stream, the app's only session stream: a
/// browser opens only a few connections per host, so one stream per card would
/// starve the rest. It starts from every card's snapshot, then each change in
/// order; each event is `{id, data}`, where `snapshot` data replaces a card's
/// state and `delta` data extends it (see runtime/session-wire.mjs). A missed
/// delta is repaired by reading that card's snapshot (`GET /api/acp/{id}`).
fn tagged(event: &'static str, id: &str, data: &str) -> Event {
    Event::default().event(event).data(format!("{{\"id\":{},\"data\":{data}}}", json!(id)))
}
fn all_snapshots(runtime: &crate::acp::AcpRuntime) -> Vec<Result<Event, Infallible>> {
    runtime.cached_all().into_iter().map(|(id, snapshot)| Ok(tagged("snapshot", &id, &snapshot.to_string()))).collect()
}
async fn acp_all_events(State(state): State<AppState>) -> Sse<impl futures::Stream<Item = Result<Event, Infallible>>> {
    let updates = state.harness.updates();
    let initial = stream::iter(all_snapshots(&state.harness));
    let runtime = state.harness.clone();
    let changes = futures::StreamExt::flat_map(BroadcastStream::new(updates), move |item| stream::iter(match item {
        Ok(update) => vec![Ok(tagged(update.event, &update.id, &update.data))],
        // Updates were missed: the current states replace them.
        Err(_) => all_snapshots(&runtime),
    }));
    Sse::new(initial.chain(changes)).keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
}
async fn acp_action(State(state): State<AppState>, Path(id): Path<String>, Json(mut body): Json<Value>) -> AppResult<Json<Value>> {
    let queue = state.queue.read_snapshot()?;
    let card = queue.cards.iter().find(|c| c.id == id).ok_or_else(|| AppError::msg("卡片不存在"))?;
    if card.archived_at.is_some() { return Err(AppError::msg("请先恢复卡片")); }
    let ws = acp_workspace(&state, &id).await?;
    if let Some(object)=body.as_object_mut() { object.remove("sender"); }
    body["id"] = json!(id); body["env"] = json!(ws.session_env);
    body["hostAccess"] = json!(card.harness.as_ref().and_then(|h| h.host_access));
    let changed = (body["action"] == "host_access").then(|| body["enabled"].as_bool()).flatten();
    let result = state.harness.request(&ws, &state.bin_dir, body).await?;
    // Host access is a card setting: remember it with the card once applied.
    if let Some(enabled) = changed {
        state.queue.with_queue(false, |queue| {
            if let Some(harness) = queue.cards.iter_mut().find(|c| c.id == id).and_then(|c| c.harness.as_mut()) { harness.host_access = Some(enabled); }
            Ok(())
        }).await?;
    }
    Ok(Json(result))
}

pub(crate) struct LaunchGuard {
    launches: Arc<Mutex<HashSet<String>>>,
    id: String,
}

impl Drop for LaunchGuard {
    fn drop(&mut self) {
        self.launches.lock().remove(&self.id);
    }
}

pub(crate) fn try_acquire_launch(state: &AppState, id: &str) -> AppResult<LaunchGuard> {
    let mut launches = state.launches.lock();
    if !launches.insert(id.to_string()) {
        return Err(AppError::machine("HARNESS_LAUNCH_IN_PROGRESS"));
    }
    Ok(LaunchGuard {
        launches: state.launches.clone(),
        id: id.to_string(),
    })
}

fn launch_identity_changed(
    card: &crate::models::QueueCard,
    workspace: &crate::models::QueueWorkspace,
    captured_card: &crate::models::QueueCard,
    captured_workspace: &crate::models::QueueWorkspace,
    previous_terminal: Option<&str>,
) -> bool {
    card.workspace_id != captured_card.workspace_id
        || card.cwd != captured_card.cwd
        || card.session.as_ref().map(|s| s.id.as_str())
            != captured_card.session.as_ref().map(|s| s.id.as_str())
        || card.harness.as_ref().map(|h| h.terminal_id.as_str()) != previous_terminal
        || card.archived_at != captured_card.archived_at
        || workspace.kind != captured_workspace.kind
        || workspace.terminal_rc != captured_workspace.terminal_rc
        || workspace.session_env != captured_workspace.session_env
        || workspace.cwd != captured_workspace.cwd
        || workspace.runtime_cwd != captured_workspace.runtime_cwd
        || workspace.ssh_host != captured_workspace.ssh_host
}

pub(crate) async fn launch_harness(
    state: &AppState,
    body: &Value,
    action: &str,
) -> AppResult<CardQueue> {
    let started = std::time::Instant::now();
    let id = body
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::machine("CARD_ID_INVALID"))?;
    crate::debuglog::info_card(
        "harness",
        id,
        None,
        &format!("startup request action={action}"),
    );
    let _guard = try_acquire_launch(state, id)?;
    let captured = state
        .queue
        .with_queue(true, |queue| {
            refresh_queue(queue, state);
            let card = queue
                .cards
                .iter()
                .find(|c| c.id == id)
                .cloned()
                .ok_or_else(|| AppError::machine("CARD_GONE"))?;
            if action == "harness_start" {
                if card.session.is_some() || card.harness.is_some() {
                    return Err(AppError::machine("HARNESS_START_NOT_BLANK"));
                }
            } else if card.harness.is_none() {
                // Resuming connects the card's own agent again (the owner's ensure is
                // idempotent: a card still connected just keeps its session).
                return Err(AppError::msg("这张卡还没有选 Agent"));
            }
            let workspace = queue
                .workspaces
                .as_ref()
                .and_then(|ws| {
                    ws.iter()
                        .find(|w| Some(&w.id) == card.workspace_id.as_ref())
                })
                .cloned()
                .ok_or_else(|| AppError::machine("WORKSPACE_MISSING"))?;
            let workspace = crate::workspace_rc::effective_workspace(queue, &workspace);
            Ok((card, workspace))
        })
        .await?;
    let kind = if action == "harness_start" {
        body.get("kind")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
    } else {
        captured
            .0
            .harness
            .as_ref()
            .map(|h| h.kind.as_str())
            .unwrap_or_default()
    };
    // The CLI owns resume validation. A session may live outside Que's default
    // store, so a local filesystem miss must not turn resume into a new launch.
    let resume = if action == "harness_start" { None } else { captured.0.harness.clone() };
    crate::debuglog::info_card(
        "harness",
        id,
        None,
        &format!(
            "startup queue-ready elapsed_ms={}",
            started.elapsed().as_millis()
        ),
    );
    let launched = match state
        .harness
        .launch(id, kind, &captured.1, resume.clone(), &state.bin_dir)
        .await
    {
        Ok(session) => session,
        Err(error) => {
            crate::debuglog::log_error(
                &format!("harness launch card={id} kind={kind} action={action}"),
                &error,
            );
            return Err(error);
        }
    };
    crate::debuglog::info_card(
        "harness",
        id,
        Some(&launched.terminal_id),
        &format!(
            "launch kind={kind} action={action} state={} request_elapsed_ms={}",
            launched.state,
            started.elapsed().as_millis()
        ),
    );
    let previous_id = captured.0.harness.as_ref().map(|h| h.terminal_id.clone());
    let result = state
        .queue
        .with_queue(false, |queue| {
            let workspace = queue
                .workspaces
                .as_ref()
                .and_then(|ws| ws.iter().find(|w| w.id == captured.1.id))
                .map(|workspace| crate::workspace_rc::effective_workspace(queue, workspace));
            let card = queue.cards.iter_mut().find(|c| c.id == id);
            let changed = match (card.as_ref(), workspace.as_ref()) {
                (Some(card), Some(workspace)) => launch_identity_changed(
                    card,
                    workspace,
                    &captured.0,
                    &captured.1,
                    previous_id.as_deref(),
                ),
                _ => true,
            };
            if changed {
                return Err(AppError::machine("HARNESS_STATE_CHANGED"));
            }
            let card = card.unwrap();
            card.harness = Some(launched.clone());
            card.phase = crate::models::CardPhase::Attention;
            card.archived_at = None;
            if !queue.order.contains(&card.id) {
                queue.order.push(card.id.clone());
            }
            refresh_queue(queue, state);
            Ok(queue.clone())
        })
        .await;
    result
}

fn valid_side_terminal_id(id: &str) -> bool {
    id.len() == 32 && id.chars().all(|c| matches!(c, 'a'..='f' | '0'..='9'))
}

fn kill_side_terminals(state: &AppState, card: &crate::models::QueueCard) {
    if let Some(tabs) = &card.side_terminals {
        for tab in tabs {
            state.terminals.kill(&tab.id);
        }
    }
}

/// A remote card's side terminals live on in tmux; archiving the card ends them.
fn try_kill_side_tmux_sessions(queue: &CardQueue, card: &crate::models::QueueCard) {
    let Some(host) = queue
        .workspaces
        .as_ref()
        .and_then(|workspaces| {
            workspaces
                .iter()
                .find(|workspace| Some(&workspace.id) == card.workspace_id.as_ref())
        })
        .filter(|workspace| workspace.kind == "ssh")
        .and_then(|workspace| workspace.ssh_host.clone())
    else {
        return;
    };

    let mut session_ids = Vec::new();
    if let Some(tabs) = &card.side_terminals {
        session_ids.extend(
            tabs.iter()
                .map(|tab| crate::ssh::card_side_tmux_session_id(&card.id, &tab.id)),
        );
    }
    if session_ids.is_empty() {
        return;
    }
    let targets: Vec<String> = session_ids
        .iter()
        .map(|id| format!("={}", crate::ssh::tmux_session_name(id)))
        .collect();
    let command = targets
        .iter()
        .map(|target| {
            format!(
                "tmux kill-session -t {} 2>/dev/null && printf '%s\\n' {} || true",
                crate::ssh::shell_quote(target),
                crate::ssh::shell_quote(target),
            )
        })
        .collect::<Vec<_>>()
        .join("; ");
    let card_id = card.id.clone();
    tokio::spawn(async move {
        match crate::ssh::ssh_exec(&host, &command).await {
            Ok(output) => crate::debuglog::info(
                "queue",
                &format!(
                    "archive tmux cleanup finished card={card_id} host={host:?} killed={:?}",
                    String::from_utf8_lossy(&output).lines().collect::<Vec<_>>()
                ),
            ),
            Err(error) => crate::debuglog::log_error(
                &format!("queue: archive tmux cleanup FAILED card={card_id} host={host:?}"),
                &error,
            ),
        }
    });
    crate::debuglog::info_card(
        "queue",
        &card.id,
        card.harness
            .as_ref()
            .map(|harness| harness.terminal_id.as_str()),
        "archive tmux cleanup requested",
    );
}

/// Applies a queue action. Returns the card it made, for `create`, so the app
/// opens exactly that card.
pub(crate) fn apply_action(
    queue: &mut CardQueue,
    body: &Value,
    action: &str,
    state: &AppState,
) -> AppResult<Option<String>> {
    let id = body.get("id").and_then(|v| v.as_str());
    let mut created = None;
    match action {
        "shell_background" => {
            let card = queue
                .cards
                .iter_mut()
                .find(|c| Some(c.id.as_str()) == id)
                .ok_or_else(|| AppError::msg("CLI 卡片不存在"))?;
            let harness = card
                .harness
                .as_mut()
                .ok_or_else(|| AppError::msg("CLI 卡片不存在"))?;
            if harness.kind != "shell"
                || harness.shell_command_notifications == Some(false)
                || harness.shell_command_running != Some(true)
            {
                return Err(AppError::msg("命令已结束或尚未运行 300ms"));
            }
            if now_ms() - harness.shell_command_started_at.unwrap_or(now_ms()) < 300 {
                return Err(AppError::msg("命令已结束或尚未运行 300ms"));
            }
            harness.shell_notify = Some(true);
        }
        "harness_close" => {
            if let Some(card) = queue.cards.iter().find(|c| Some(c.id.as_str()) == id) {
                try_kill_side_tmux_sessions(queue, card);
            }
            let card = queue
                .cards
                .iter_mut()
                .find(|c| Some(c.id.as_str()) == id)
                .ok_or_else(|| AppError::msg("CLI 卡片不存在"))?;
            crate::debuglog::info_card(
                "queue",
                &card.id,
                card.harness.as_ref().map(|h| h.terminal_id.as_str()),
                "harness_close",
            );
            kill_side_terminals(state, card);
            card.side_terminals = None;
            card.side_terminal_open = None;
            if let Some(harness) = card.harness.as_mut() {
                state.terminals.stop(&harness.terminal_id);
                harness.state = "exited".into();
            }
            card.phase = crate::models::CardPhase::Attention;
            card.detached = None;
            archive_card(queue, id.unwrap())?;
        }
        "sort_mode" => {
            let mode = body
                .get("mode")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            if !["fifo", "score"].contains(&mode) {
                return Err(AppError::msg("无效排序模式"));
            }
            queue.sort_mode = Some(mode.into());
            queue.insertion_position = Some("bottom".into());
        }
        "turn_tags_enabled" => {
            queue.turn_tags_enabled = body.get("enabled").and_then(|v| v.as_bool())
        }
        "turn_tags" => {
            queue.turn_tag_definitions =
                serde_json::from_value(body.get("tags").cloned().unwrap_or(json!([]))).ok();
        }
        "workspace_weight" => {
            let workspace_id = body
                .get("workspaceId")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            let workspace = queue
                .workspaces
                .as_mut()
                .and_then(|ws| ws.iter_mut().find(|w| w.id == workspace_id))
                .ok_or_else(|| AppError::machine("WORKSPACE_MISSING"))?;
            workspace.default_conversation_weight =
                Some(numeric_weight(body.get("weight").unwrap_or(&json!(0))));
        }
        "workspace_update" => {
            let workspace_id = body
                .get("workspaceId")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            let workspace = queue
                .workspaces
                .as_mut()
                .and_then(|ws| ws.iter_mut().find(|w| w.id == workspace_id))
                .ok_or_else(|| AppError::machine("WORKSPACE_MISSING"))?;
            let name = body
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();
            if name.is_empty() {
                return Err(AppError::msg("请输入工作区名称"));
            }
            workspace.name = name.into();
            workspace.default_conversation_weight = Some(numeric_weight(
                body.get("defaultConversationWeight").unwrap_or(&json!(0)),
            ));
        }
        "machine_settings_update" => {
            let key = body.get("machineKey").and_then(Value::as_str).unwrap_or_default();
            if key != "local" && !key.strip_prefix("ssh:").is_some_and(valid_ssh_host) {
                return Err(AppError::msg("Invalid machine"));
            }
            let rc = body.get("terminalRc").and_then(Value::as_str)
                .ok_or_else(|| AppError::msg("RC must be text"))?;
            crate::workspace_rc::validate_size(rc)?;
            let env = crate::workspace_rc::validate_session_env(
                body.get("sessionEnv").ok_or_else(|| AppError::msg("Session environment required"))?
            )?;
            queue.machine_settings.insert(key.to_string(), crate::models::MachineSessionSettings {
                terminal_rc: if rc.trim().is_empty() { None } else { Some(rc.to_string()) },
                session_env: env,
            });
        }
        "priority_weight" => {
            let card = queue
                .cards
                .iter_mut()
                .find(|c| Some(c.id.as_str()) == id)
                .ok_or_else(|| AppError::msg("卡片不存在"))?;
            card.priority_weight = Some(numeric_weight(body.get("weight").unwrap_or(&json!(0))));
        }
        "card_nickname" => {
            let nickname = body
                .get("nickname")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim();
            if nickname.chars().count() > 48
                || nickname.chars().any(|character| character.is_control())
            {
                return Err(AppError::msg("昵称最多 48 个字符，且不能包含控制字符"));
            }
            let card = queue
                .cards
                .iter_mut()
                .find(|c| Some(c.id.as_str()) == id)
                .ok_or_else(|| AppError::msg("卡片不存在"))?;
            card.nickname = (!nickname.is_empty()).then(|| nickname.to_string());
        }
        "reset_wait" => {
            let card = queue
                .cards
                .iter_mut()
                .find(|c| Some(c.id.as_str()) == id)
                .ok_or_else(|| AppError::msg("卡片未在等待处理"))?;
            if !matches!(card.phase, crate::models::CardPhase::Attention) {
                return Err(AppError::msg("卡片未在等待处理"));
            }
            card.waiting_since = Some(now_ms());
        }
        "insertion_position" => {
            let position = body
                .get("position")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            if !["top", "bottom"].contains(&position) {
                return Err(AppError::msg("请选择顶部插入或底部插入"));
            }
            queue.insertion_position = Some(position.into());
        }
        "workspace_create" => {
            let name = body
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            let cwd_in = body
                .get("cwd")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            let kind = body
                .get("kind")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            if name.is_empty() {
                return Err(AppError::msg("请输入工作区名称"));
            }
            if cwd_in.is_empty() {
                return Err(AppError::msg("请输入工作区目录"));
            }
            if !["local", "ssh"].contains(&kind.as_str()) {
                return Err(AppError::msg("请选择工作区位置"));
            }
            let (cwd, ssh_host, runtime_cwd, id) = if kind == "local" {
                let cwd = crate::paths::ordinary_windows_path(crate::paths::expand_user(&cwd_in));
                if !cwd.is_dir() {
                    return Err(AppError::msg("工作目录不存在"));
                }
                (
                    cwd.to_string_lossy().into_owned(),
                    None,
                    cwd.to_string_lossy().into_owned(),
                    Uuid::new_v4().to_string(),
                )
            } else {
                let host = body
                    .get("sshHost")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default();
                if !valid_ssh_host(host) {
                    return Err(AppError::msg("请输入 SSH 主机别名或 user@host"));
                }
                if !cwd_in.starts_with('/') {
                    return Err(AppError::msg("SSH 工作目录请使用绝对路径"));
                }
                let resolved = cwd_in.clone();
                let id = Uuid::new_v4().to_string();
                let runtime = ssh_runtime_dir(&id);
                std::fs::create_dir_all(&runtime)?;
                std::fs::write(
                    runtime.join("remote-workspace.json"),
                    serde_json::json!({ "sshHost": host, "cwd": resolved }).to_string(),
                )?;
                (
                    resolved,
                    Some(host.to_string()),
                    runtime.to_string_lossy().into_owned(),
                    id,
                )
            };
            {
                let workspaces = queue.workspaces.get_or_insert_with(Vec::new);
                if let Some(existing) = workspaces
                    .iter_mut()
                    .find(|w| w.kind == kind && w.cwd == cwd && w.ssh_host == ssh_host)
                {
                    existing.name = name;
                    existing.default_conversation_weight = Some(numeric_weight(
                        body.get("defaultConversationWeight").unwrap_or(&json!(0)),
                    ));
                } else {
                    workspaces.push(crate::models::QueueWorkspace {
                        terminal_rc: None,
                        session_env: Default::default(),
                        id,
                        name,
                        kind,
                        cwd,
                        ssh_host,
                        runtime_cwd,
                        default_conversation_weight: Some(numeric_weight(
                            body.get("defaultConversationWeight").unwrap_or(&json!(0)),
                        )),
                    });
                }
            }
        }
        "workspace_remove" => {
            let workspace_id = body
                .get("workspaceId")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            let removed: Vec<String> = queue
                .cards
                .iter()
                .filter(|c| c.workspace_id.as_deref() == Some(workspace_id))
                .map(|c| c.id.clone())
                .collect();
            for card in &queue.cards {
                if removed.contains(&card.id) {
                    if let Some(harness) = &card.harness {
                        state.terminals.kill(&harness.terminal_id);
                    }
                    kill_side_terminals(state, card);
                }
            }
            queue.cards.retain(|c| !removed.contains(&c.id));
            queue.order.retain(|id| !removed.contains(id));
            if let Some(ws) = queue.workspaces.as_mut() {
                ws.retain(|w| w.id != workspace_id);
            }
        }
        "create" => {
            let workspace_id = body
                .get("workspaceId")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            let workspace = queue
                .workspaces
                .as_ref()
                .and_then(|ws| ws.iter().find(|w| w.id == workspace_id))
                .cloned()
                .ok_or_else(|| AppError::msg("请选择一个工作区"))?;
            let kind = body.get("kind").and_then(Value::as_str).filter(|kind| !kind.trim().is_empty())
                .ok_or_else(|| AppError::msg("请选择一个 Agent"))?;
            let nickname = body.get("nickname").and_then(Value::as_str).map(str::trim).filter(|n| !n.is_empty());
            if nickname.is_some_and(|n| n.chars().count() > 48 || n.chars().any(char::is_control)) {
                return Err(AppError::msg("昵称最多 48 个字符，且不能包含控制字符"));
            }
            let card = uuid::Uuid::new_v4().to_string();
            crate::queue::new_card(queue, &card, &workspace, kind, nickname)?;
            crate::debuglog::info("queue", &format!("create workspace={} kind={kind}", workspace.id));
            created = Some(card);
        }
        "remind_later" => {
            let minutes = body.get("minutes").and_then(|v| v.as_i64()).unwrap_or(0);
            if minutes <= 0 || minutes > 24 * 60 {
                return Err(AppError::msg("无效的提醒间隔"));
            }
            let card = queue
                .cards
                .iter()
                .find(|c| Some(c.id.as_str()) == id)
                .ok_or_else(|| AppError::msg("卡片不存在"))?;
            if card.session.is_none() && card.harness.is_none() {
                return Err(AppError::msg("空白卡片无需提醒"));
            }
            if matches!(card.phase, crate::models::CardPhase::Working) {
                return Err(AppError::msg("卡片正在工作中"));
            }
            if card.archived_at.is_some() {
                return Err(AppError::msg("卡片已归档"));
            }
            let deadline = now_ms() + minutes * 60_000;
            if !park_remind(queue, id.unwrap_or_default(), deadline) {
                return Err(AppError::msg("卡片无法进入稍后提醒"));
            }
        }
        "remind_back" => {
            let card = queue
                .cards
                .iter()
                .find(|c| Some(c.id.as_str()) == id)
                .ok_or_else(|| AppError::machine("CARD_GONE"))?;
            if matches!(card.phase, crate::models::CardPhase::Working) {
                return Err(AppError::msg("卡片正在工作中"));
            }
            if !release_remind(queue, id.unwrap_or_default()) {
                return Err(AppError::msg("该卡片不在稍后提醒中"));
            }
        }
        "front" | "back" => move_card(queue, id.unwrap_or_default(), action),
        "archive" => {
            let card = queue
                .cards
                .iter()
                .find(|c| Some(c.id.as_str()) == id)
                .ok_or_else(|| AppError::msg("卡片已不存在"))?;
            if card.session.is_none() && card.harness.is_none() {
                return Err(AppError::msg("空白卡片无需归档"));
            }
            if matches!(card.phase, crate::models::CardPhase::Working) || card.detached.is_some() {
                return Err(AppError::msg("请先结束工作并收回卡片"));
            }
            crate::debuglog::info_card(
                "queue",
                &card.id,
                card.harness.as_ref().map(|h| h.terminal_id.as_str()),
                "archive",
            );
            try_kill_side_tmux_sessions(queue, card);
            if let Some(harness) = &card.harness {
                state.terminals.stop(&harness.terminal_id);
            }
            kill_side_terminals(state, card);
            archive_card(queue, id.unwrap_or_default())?;
            if let Some(card) = queue.cards.iter_mut().find(|c| Some(c.id.as_str()) == id) {
                if let Some(harness) = card.harness.as_mut() {
                    harness.state = "exited".into();
                }
                card.side_terminals = None;
                card.side_terminal_open = None;
            }
        }
        "restore" => {
            let card = queue
                .cards
                .iter_mut()
                .find(|c| Some(c.id.as_str()) == id)
                .ok_or_else(|| AppError::machine("CARD_GONE"))?;
            crate::debuglog::info_card("queue", &card.id, None, "restore");
            card.archived_at = None;
            move_card(queue, id.unwrap_or_default(), "front");
        }
        "remove" => {
            if let Some(card) = queue.cards.iter().find(|c| Some(c.id.as_str()) == id) {
                if matches!(card.phase, crate::models::CardPhase::Working) {
                    return Err(AppError::msg("请先处理等待中的交互，或停止正在运行的会话"));
                }
                if card.detached.is_some() {
                    return Err(AppError::msg("请先收回独立窗口"));
                }
                crate::debuglog::info_card(
                    "queue",
                    &card.id,
                    card.harness.as_ref().map(|h| h.terminal_id.as_str()),
                    "remove",
                );
                if let Some(harness) = &card.harness {
                    state.terminals.kill(&harness.terminal_id);
                }
                kill_side_terminals(state, card);
            }
            queue.cards.retain(|c| Some(c.id.as_str()) != id);
            queue.order.retain(|item| Some(item.as_str()) != id);
        }
        "claim" => {
            let owner = body
                .get("owner")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            let card = queue
                .cards
                .iter_mut()
                .find(|c| Some(c.id.as_str()) == id)
                .ok_or_else(|| AppError::msg("无效的窗口"))?;
            if owner.is_empty() {
                return Err(AppError::msg("无效的窗口"));
            }
            if let Some(detached) = &card.detached {
                if detached.owner != owner {
                    return Err(AppError::msg("该卡片已经在另一个窗口打开"));
                }
            }
            crate::debuglog::info_card(
                "queue",
                &card.id,
                card.harness.as_ref().map(|h| h.terminal_id.as_str()),
                "detach",
            );
            card.detached = Some(crate::models::DetachedLease {
                owner: owner.into(),
                expires_at: now_ms() + TAB_LEASE_MS,
            });
        }
        "release" => {
            let owner = body
                .get("owner")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            if let Some(card) = queue.cards.iter_mut().find(|c| Some(c.id.as_str()) == id) {
                if card.detached.as_ref().is_some_and(|d| d.owner == owner) {
                    crate::debuglog::info_card("queue", &card.id, None, "return");
                    card.detached = None;
                }
            }
        }
        "side_terminal_add" => {
            let card = queue
                .cards
                .iter_mut()
                .find(|c| Some(c.id.as_str()) == id)
                .ok_or_else(|| AppError::machine("CARD_GONE"))?;
            let terminal_id = body
                .get("terminalId")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            if !valid_side_terminal_id(terminal_id) {
                return Err(AppError::msg("无效的终端"));
            }
            crate::debuglog::bind_term(terminal_id, &card.id);
            crate::debuglog::info_card("queue", &card.id, Some(terminal_id), "side_terminal_add");
            let cwd = body
                .get("cwd")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or(card.cwd.as_str())
                .to_string();
            let tabs = card.side_terminals.get_or_insert_with(Vec::new);
            if !tabs.iter().any(|tab| tab.id == terminal_id) {
                tabs.push(crate::models::CardSideTerminal {
                    id: terminal_id.into(),
                    cwd,
                });
            }
        }
        "side_terminal_remove" => {
            let terminal_id = body
                .get("terminalId")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            if !valid_side_terminal_id(terminal_id) {
                return Err(AppError::msg("无效的终端"));
            }
            let ssh_host = queue
                .cards
                .iter()
                .find(|c| Some(c.id.as_str()) == id)
                .and_then(|c| {
                    queue
                        .workspaces
                        .as_ref()
                        .and_then(|ws| ws.iter().find(|w| Some(&w.id) == c.workspace_id.as_ref()))
                })
                .and_then(|w| {
                    if w.kind == "ssh" {
                        w.ssh_host.clone()
                    } else {
                        None
                    }
                });
            if let Some(card) = queue.cards.iter_mut().find(|c| Some(c.id.as_str()) == id) {
                if let Some(tabs) = card.side_terminals.as_mut() {
                    tabs.retain(|tab| tab.id != terminal_id);
                    if tabs.is_empty() {
                        card.side_terminals = None;
                        card.side_terminal_open = None;
                    }
                }
            }
            crate::debuglog::info_card(
                "queue",
                id.unwrap_or(""),
                Some(terminal_id),
                "side_terminal_remove",
            );
            crate::debuglog::unbind_term(terminal_id);
            state.terminals.kill(terminal_id);
            if let Some(host) = ssh_host {
                let tid = terminal_id.to_string();
                let cid = id.unwrap_or("").to_string();
                tokio::spawn(async move {
                    let s1 = crate::ssh::tmux_session_name(&crate::ssh::card_side_tmux_session_id(
                        &cid, &tid,
                    ));
                    let s2 = crate::ssh::tmux_session_name(&tid);
                    let cmd = format!("tmux kill-session -t {} 2>/dev/null || tmux kill-session -t {} 2>/dev/null || true", crate::ssh::shell_quote(&s1), crate::ssh::shell_quote(&s2));
                    let _ = crate::ssh::ssh_exec(&host, &cmd).await;
                });
            }
        }
        "side_terminal_open" => {
            let card = queue
                .cards
                .iter_mut()
                .find(|c| Some(c.id.as_str()) == id)
                .ok_or_else(|| AppError::machine("CARD_GONE"))?;
            let open = body.get("open").and_then(|v| v.as_bool()).unwrap_or(false);
            card.side_terminal_open = open.then_some(true);
        }
        _ => return Err(AppError::msg("未知队列操作")),
    }
    Ok(created)
}

async fn queue_events(
    State(state): State<AppState>,
) -> Sse<impl futures::Stream<Item = Result<Event, Infallible>>> {
    let rx = state.live.subscribe();
    let stream = BroadcastStream::new(rx).filter_map(|item| {
        item.ok().map(|reason| {
            Ok(Event::default().data(json!({ "type": "change", "reason": reason }).to_string()))
        })
    });
    Sse::new(stream::once(async { Ok(Event::default().comment("")) }).chain(stream))
        .keep_alive(KeepAlive::new().interval(Duration::from_secs(30)))
}

async fn list_machines(State(state): State<AppState>) -> AppResult<impl IntoResponse> {
    Ok(Json(json!({ "hosts": state.hosts.list().await? })))
}

async fn machine_action(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    let action = body
        .get("action")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    crate::debuglog::debug("api", &format!("machines.{action}"));
    match machine_action_inner(&state, body).await {
        Ok(value) => (StatusCode::OK, Json(value)).into_response(),
        Err(error) => {
            crate::debuglog::log_error("machine_action error", &error);
            error.into_response()
        }
    }
}

#[derive(Deserialize)]
struct TestHostInput {
    hostname: String,
    #[serde(default)]
    user: Option<String>,
    #[serde(default)]
    port: Option<u16>,
}

#[derive(Deserialize)]
struct SaveHostInput {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    name: Option<String>,
    hostname: String,
    #[serde(default)]
    user: Option<String>,
    #[serde(default)]
    port: Option<u16>,
}

pub(crate) async fn machine_action_inner(state: &AppState, body: Value) -> AppResult<Value> {
    let action = body
        .get("action")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    match action {
        "save" => {
            // The editor may submit an unsaved host (no id yet); accept the
            // partial form and default name/id like HostStore::save expects.
            let input: SaveHostInput =
                serde_json::from_value(body.get("host").cloned().unwrap_or(json!({})))?;
            let name = input
                .name
                .filter(|name| !name.trim().is_empty())
                .unwrap_or_else(|| input.hostname.clone());
            let host = RemoteHost {
                id: input.id.unwrap_or_default(),
                name,
                hostname: input.hostname,
                user: input.user.filter(|user| !user.is_empty()),
                port: input.port,
                identity_file: None,
                source: "web".into(),
                visible: None,
                connected: None,
            };
            Ok(json!({ "host": state.hosts.save(host).await? }))
        }
        "delete" => {
            let id = body.get("id").and_then(|v| v.as_str()).unwrap_or_default();
            state.hosts.delete(id).await?;
            Ok(json!({ "ok": true }))
        }
        "set-visibility" => {
            let host = body
                .get("host")
                .and_then(|v| v.as_str())
                .ok_or_else(|| AppError::machine("HOST_INVALID"))?;
            let visible = body
                .get("visible")
                .and_then(|v| v.as_bool())
                .ok_or_else(|| AppError::machine("HOST_INVALID"))?;
            state.hosts.set_visibility(host, visible).await?;
            Ok(json!({ "ok": true }))
        }
        "test" => {
            // The editor submits an unsaved host (hostname/user/port only), so a
            // full RemoteHost parse would fail; accept the partial form instead.
            let input: TestHostInput =
                serde_json::from_value(body.get("host").cloned().unwrap_or(json!({})))?;
            crate::debuglog::info(
                "ssh",
                &format!(
                    "test host={:?} user={:?} port={:?}",
                    input.hostname, input.user, input.port
                ),
            );
            let target = RemoteHost {
                id: input.hostname.clone(),
                name: input.hostname.clone(),
                hostname: input.hostname,
                user: input.user.filter(|user| !user.is_empty()),
                port: input.port,
                identity_file: None,
                source: "test".into(),
                visible: None,
                connected: None,
            };
            match test_target(target, password(&body)?, trusted(&body)).await {
                Ok(()) => {
                    crate::debuglog::info("ssh", "test ok");
                    Ok(json!({ "ok": true }))
                }
                Err(error) => {
                    crate::debuglog::log_error("api: machines.test FAILED", &error);
                    Err(error)
                }
            }
        }
        "local-folder" => {
            let locale = body
                .get("locale")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            match pick_local_folder(locale).await? {
                Some(cwd) => Ok(json!({ "cwd": cwd })),
                None => Ok(json!({ "cancelled": true })),
            }
        }
        "test-host" | "connect" => {
            let host = body
                .get("host")
                .and_then(|v| v.as_str())
                .ok_or_else(|| AppError::machine("HOST_INVALID"))?;
            crate::debuglog::info("ssh", &format!("{action} host={host:?}"));
            match connect_host(host, password(&body)?, trusted(&body)).await {
                Ok(()) => crate::debuglog::info("ssh", &format!("{action} ok host={host:?}")),
                Err(error) => {
                    crate::debuglog::log_error(
                        &format!("api: machines.{action} connect FAILED host={host:?}"),
                        &error,
                    );
                    return Err(error);
                }
            }
            if action == "connect" {
                let cwd = match ssh_exec(host, r#"printf "%s" "$HOME""#).await {
                    Ok(bytes) => {
                        crate::debuglog::debug(
                            "ssh",
                            &format!("connect home={:?}", String::from_utf8_lossy(&bytes)),
                        );
                        String::from_utf8_lossy(&bytes).into_owned()
                    }
                    Err(error) => {
                        crate::debuglog::log_error(
                            &format!("api: machines.connect home lookup FAILED host={host:?}"),
                            &error,
                        );
                        return Err(error);
                    }
                };
                return Ok(json!({ "cwd": cwd }));
            }
            Ok(json!({ "ok": true }))
        }
        "directories" => {
            let host = body
                .get("host")
                .and_then(|v| v.as_str())
                .ok_or_else(|| AppError::machine("HOST_INVALID"))?;
            let path = body
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| AppError::machine("PATH_INVALID"))?;
            if !path.starts_with('/') || path.contains('\0') {
                return Err(AppError::machine("PATH_INVALID"));
            }
            let slash = path.rfind('/').unwrap_or(0);
            let parent = &path[..=slash];
            let prefix = &path[slash + 1..];
            let output = ssh_exec(host, &format!("cd {} && for p in ./* ./.[!.]* ./..?*; do [ -d \"$p\" ] && printf '%s\\0' \"$p\"; done; true", crate::ssh::shell_quote(parent))).await?;
            let mut entries: Vec<String> = String::from_utf8_lossy(&output)
                .split('\0')
                .filter(|s| !s.is_empty())
                .map(|s| s.trim_start_matches("./").to_string())
                .filter(|s| s.starts_with(prefix))
                .collect();
            entries.sort();
            let truncated = entries.len() > 300;
            let directories: Vec<Value> = entries
                .into_iter()
                .take(300)
                .map(|name| json!({ "name": name, "path": format!("{parent}{name}/") }))
                .collect();
            Ok(json!({ "directories": directories, "truncated": truncated }))
        }
        _ => Err(AppError::machine("REQUEST_FAILED")),
    }
}

fn password(body: &Value) -> AppResult<Option<String>> {
    match body.get("password") {
        None => Ok(None),
        Some(Value::String(value))
            if value.len() <= 8192
                && !value.chars().any(|c| c == '\n' || c == '\r' || c == '\0') =>
        {
            Ok(Some(value.clone()))
        }
        _ => Err(AppError::machine("PASSWORD_INVALID")),
    }
}

fn trusted(body: &Value) -> Option<String> {
    body.get("trustedPrompt")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

#[derive(Deserialize)]
struct BrowseQuery {
    path: Option<String>,
}

async fn browse_cwd(Query(query): Query<BrowseQuery>) -> AppResult<impl IntoResponse> {
    Ok(Json(browse(query.path)?))
}

fn tools_json(settings: &crate::models::AppSettings) -> Value {
    json!({
        "isWindows": cfg!(windows),
        "powerShellEnabled": settings.powershell_enabled,
        "developerProbes": crate::dev_tools::probes_enabled(),
        "debugLogging": crate::debuglog::verbose(),
        "logPath": crate::debuglog::log_path().to_string_lossy(),
        "logDir": crate::paths::logs_dir().to_string_lossy(),
    })
}

async fn get_tools(State(state): State<AppState>) -> AppResult<impl IntoResponse> {
    Ok(Json(tools_json(&state.settings.read()?)))
}

async fn put_tools(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> AppResult<impl IntoResponse> {
    if let Some(enabled) = body.get("debugLogging").and_then(|v| v.as_bool()) {
        let settings = state.settings.set_debug_logging(enabled).await?;
        return Ok(Json(tools_json(&settings)));
    }
    let enabled = body
        .get("enabled")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let settings = state.settings.set_powershell(enabled).await?;
    Ok(Json(tools_json(&settings)))
}

async fn harness_debug(State(state): State<AppState>, Path(id): Path<String>) -> impl IntoResponse {
    Json(state.harness.debug_snapshot(&id, &state.terminals)).into_response()
}

async fn extension_harnesses() -> impl IntoResponse { Json(json!({ "harnesses": [], "errors": [] })) }
async fn reload_extensions() -> impl IntoResponse { extension_harnesses().await }

#[derive(Deserialize)]
struct LogsQuery {
    card: Option<String>,
    term: Option<String>,
    bytes: Option<usize>,
}

async fn get_logs(Query(query): Query<LogsQuery>) -> impl IntoResponse {
    let mut text =
        crate::debuglog::read_tail(query.bytes.unwrap_or(256 * 1024).min(2 * 1024 * 1024));
    if query.card.is_some() || query.term.is_some() {
        text = crate::debuglog::filter_text(&text, query.card.as_deref(), query.term.as_deref());
    }
    ([(header::CONTENT_TYPE, "text/plain; charset=utf-8")], text)
}

#[derive(Deserialize)]
struct FrontLog {
    #[serde(default)]
    level: Option<String>,
    #[serde(default)]
    sys: Option<String>,
    #[serde(default)]
    card: Option<String>,
    #[serde(default)]
    term: Option<String>,
    #[serde(default)]
    msg: Option<String>,
}

async fn post_log(Json(body): Json<FrontLog>) -> impl IntoResponse {
    let level = match body.level.as_deref().unwrap_or("info") {
        "error" => crate::debuglog::Level::Error,
        "warn" | "warning" => crate::debuglog::Level::Warn,
        "debug" => crate::debuglog::Level::Debug,
        "trace" => crate::debuglog::Level::Trace,
        _ => crate::debuglog::Level::Info,
    };
    let sys = body
        .sys
        .as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or("ui");
    let msg = body.msg.as_deref().unwrap_or("");
    if msg.len() > 4000 {
        return StatusCode::BAD_REQUEST;
    }
    if let Some(card) = body.card.as_deref().filter(|s| !s.is_empty()) {
        if let Some(term) = body.term.as_deref().filter(|s| !s.is_empty()) {
            crate::debuglog::bind_term(term, card);
        }
    }
    crate::debuglog::write(level, sys, body.card.as_deref(), body.term.as_deref(), msg);
    StatusCode::NO_CONTENT
}

fn resolve_report_term(
    state: &AppState,
    card_id: Option<&str>,
    term_id: Option<&str>,
) -> Option<String> {
    if let Some(term) = term_id.filter(|s| !s.is_empty()) {
        return Some(term.to_string());
    }
    let card_id = card_id?;
    state
        .queue
        .read_snapshot()
        .ok()?
        .cards
        .into_iter()
        .find(|c| c.id == card_id)
        .and_then(|c| c.harness.map(|h| h.terminal_id))
}

fn card_report_text(
    state: &AppState,
    card_id: Option<&str>,
    term_id: Option<&str>,
    extra: Option<&str>,
) -> String {
    let term_id = resolve_report_term(state, card_id, term_id);
    let card = card_id.and_then(|id| {
        state
            .queue
            .read_snapshot()
            .ok()?
            .cards
            .into_iter()
            .find(|c| c.id == id)
    });
    let mut out = String::from("# Que card report\n");
    if let Some(card) = &card {
        out.push_str(&format!(
            "card={} phase={:?} workspace={:?} cwd={} detached={} archived={}\n",
            card.id,
            card.phase,
            card.workspace_id,
            card.cwd,
            card.detached.is_some(),
            card.archived_at.is_some()
        ));
        if let Some(harness) = &card.harness {
            out.push_str(&format!(
                "harness kind={} state={} term={} remote={:?} probe={:?}\n",
                harness.kind, harness.state, harness.terminal_id, harness.remote, harness.probe
            ));
        }
        if let Some(tabs) = &card.side_terminals {
            out.push_str(&format!(
                "side_terminals={}\n",
                tabs.iter()
                    .map(|t| t.id.as_str())
                    .collect::<Vec<_>>()
                    .join(",")
            ));
        }
    } else if let Some(card) = card_id {
        out.push_str(&format!("card={card} (not in queue)\n"));
    }
    if let Some(term) = &term_id {
        let snap = state.harness.debug_snapshot(term, &state.terminals);
        out.push_str("\n# harness\n");
        out.push_str(&serde_json::to_string_pretty(&snap).unwrap_or_else(|_| "{}".into()));
        out.push('\n');
    }
    if let Some(extra) = extra.filter(|s| !s.is_empty()) {
        out.push_str("\n# extra\n");
        out.push_str(extra);
        out.push('\n');
    }
    out.push_str("\n# log\n");
    let logs = crate::debuglog::read_tail(256 * 1024);
    out.push_str(&crate::debuglog::filter_text(
        &logs,
        card_id,
        term_id.as_deref(),
    ));
    out.push('\n');
    out
}

fn report_file_name(card_id: Option<&str>, term_id: Option<&str>) -> String {
    let raw = card_id.or(term_id).unwrap_or("unknown");
    let safe: String = raw
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .take(80)
        .collect();
    format!("card-{safe}.txt")
}

async fn get_log_report(
    State(state): State<AppState>,
    Query(query): Query<LogsQuery>,
) -> impl IntoResponse {
    let text = card_report_text(&state, query.card.as_deref(), query.term.as_deref(), None);
    ([(header::CONTENT_TYPE, "text/plain; charset=utf-8")], text)
}

#[derive(Deserialize)]
struct ExportReport {
    #[serde(default, alias = "card", alias = "cardId")]
    card_id: Option<String>,
    #[serde(default, alias = "term", alias = "termId")]
    term_id: Option<String>,
    #[serde(default)]
    extra: Option<String>,
}

async fn export_log_report(
    State(state): State<AppState>,
    Json(body): Json<ExportReport>,
) -> AppResult<impl IntoResponse> {
    let text = card_report_text(
        &state,
        body.card_id.as_deref(),
        body.term_id.as_deref(),
        body.extra.as_deref(),
    );
    let dir = crate::paths::logs_dir();
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(report_file_name(
        body.card_id.as_deref(),
        body.term_id.as_deref(),
    ));
    crate::paths::atomic_write(&path, &text)?;
    crate::debuglog::info("app", &format!("wrote card report {}", path.display()));
    Ok(Json(json!({
        "path": path.to_string_lossy(),
        "logDir": dir.to_string_lossy(),
    })))
}

async fn get_terminal(State(state): State<AppState>, Path(id): Path<String>) -> impl IntoResponse {
    match state.terminals.cwd(&id) {
        Some(cwd) => (StatusCode::OK, Json(json!({ "id": id, "cwd": cwd, "readOnly": state.terminals.snapshot(&id).map(|s| s.exited).unwrap_or(true) }))).into_response(),
        None => (StatusCode::NOT_FOUND, Json(json!({ "error": "Terminal expired or closed" }))).into_response(),
    }
}

async fn set_terminal_theme(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    state.terminals.apply_canvas_theme(
        body.get("dark").and_then(|v| v.as_bool()).unwrap_or(false),
        body.get("refresh")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
    );
    StatusCode::NO_CONTENT
}

/// Whether local sessions must keep the Campbell palette: true only when the
/// bundled modern ConPTY is unavailable and the inbox kernel32 build is in use.
async fn get_terminal_theme() -> impl IntoResponse {
    let conpty_fallback = cfg!(windows) && !crate::conpty::sideloaded();
    Json(
        json!({ "conptyFallback": conpty_fallback, "windowsBuild": crate::conpty::host_build_number() }),
    )
}

async fn create_terminal(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    match create_terminal_inner(&state, &body).await {
        Ok(id) => (StatusCode::OK, Json(json!({ "id": id }))).into_response(),
        Err(error) => error.into_response(),
    }
}

async fn create_terminal_inner(state: &AppState, body: &Value) -> AppResult<String> {
    crate::debuglog::debug(
        "pty",
        &format!(
            "create cwd={:?} sshHost={:?} id={:?}",
            body.get("cwd").and_then(|v| v.as_str()).unwrap_or(""),
            body.get("sshHost").and_then(|v| v.as_str()),
            body.get("id").and_then(|v| v.as_str())
        ),
    );
    if let Some(id) = body.get("id") {
        let Some(id) = id.as_str() else {
            return Err(AppError::msg("Invalid terminal id"));
        };
        if id.len() != 32 || !id.chars().all(|c| matches!(c, 'a'..='f' | '0'..='9')) {
            return Err(AppError::msg("Invalid terminal id"));
        }
    }
    let cwd = body
        .get("cwd")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if cwd.is_empty() {
        return Err(AppError::msg("cwd required"));
    }
    let cols = json_dimension(body.get("cols")).unwrap_or(80);
    let rows = json_dimension(body.get("rows")).unwrap_or(24);
    let id = body.get("id").and_then(|v| v.as_str()).map(str::to_string);
    let target = terminal_target(cwd, terminal_ssh_host(body)?)?;
    let created = match target {
        TerminalTarget::Local(cwd) => {
            state
                .terminals
                .create_shell(cwd.to_string_lossy().into_owned(), cols, rows, id)
        }
        TerminalTarget::Remote { host, directory } => {
            let card_id = body
                .get("cardId")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            let use_tmux = if let Some(card_id) = card_id.as_deref() {
                state
                    .queue
                    .read_snapshot()
                    .ok()
                    .and_then(|q| {
                        q.cards
                            .iter()
                            .find(|c| c.id == card_id)
                            .and_then(|c| c.harness.as_ref().and_then(|h| h.tmux))
                    })
                    .unwrap_or(true)
            } else {
                true
            };
            state
                .terminals
                .create_remote_shell(directory, cols, rows, id, host, use_tmux, card_id)
        }
    };
    if let Ok(term) = &created {
        if let Some(card) = body
            .get("cardId")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
        {
            crate::debuglog::bind_term(term, card);
        }
    }
    created
}

/// Where a new terminal runs.
enum TerminalTarget {
    Local(PathBuf),
    /// `directory` is an absolute path on `host`, not on this machine.
    Remote {
        host: String,
        directory: String,
    },
}

/// The SSH host a terminal-create request asks for, if it asks for one.
fn terminal_ssh_host(body: &Value) -> AppResult<Option<String>> {
    let host = body
        .get("sshHost")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if host.is_empty() {
        return Ok(None);
    }
    if !valid_ssh_host(host) {
        return Err(AppError::msg("请输入 SSH 主机别名或 user@host"));
    }
    Ok(Some(host.to_string()))
}

/// Resolve a create request against the machine the terminal will actually run
/// on.
///
/// A remote directory is deliberately not checked with `is_dir()`: the path
/// belongs to the other machine, and on Windows a POSIX path like `/srv/app` is
/// not even absolute, so the check would answer about the wrong filesystem —
/// and answer no.
fn terminal_target(cwd: &str, host: Option<String>) -> AppResult<TerminalTarget> {
    match host {
        None => {
            let cwd = resolve_terminal_cwd(cwd);
            if !cwd.is_dir() {
                return Err(AppError::msg("cwd must be a directory"));
            }
            Ok(TerminalTarget::Local(cwd))
        }
        Some(host) => {
            if !cwd.starts_with('/') {
                return Err(AppError::msg("SSH 工作目录请使用绝对路径"));
            }
            Ok(TerminalTarget::Remote {
                host,
                directory: cwd.to_string(),
            })
        }
    }
}

/// An SSH host alias or `user@host`. The value goes to ssh config resolution
/// rather than to a shell, but the workspace editor and the terminal API share
/// one rule so neither can accept a value the other rejects.
fn valid_ssh_host(host: &str) -> bool {
    static HOST: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    HOST.get_or_init(|| regex::Regex::new(r"^[a-zA-Z0-9][a-zA-Z0-9._@:-]*$").expect("host pattern"))
        .is_match(host)
}

fn resolve_terminal_cwd(cwd: &str) -> PathBuf {
    let path = PathBuf::from(cwd);
    if path.is_absolute() {
        crate::paths::ordinary_windows_path(path)
    } else {
        crate::paths::ordinary_windows_path(
            std::env::current_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .join(path),
        )
    }
}

fn json_dimension(value: Option<&Value>) -> Option<u16> {
    let value = value?;
    let number = match value {
        Value::Number(n) if n.is_u64() => n.as_u64()? as f64,
        Value::Number(n) if n.is_i64() => n.as_i64()? as f64,
        Value::Number(n) => n.as_f64()?,
        _ => return None,
    };
    if number.fract() != 0.0 || !(2.0..=1000.0).contains(&number) {
        return None;
    }
    Some(number as u16)
}

fn json_int_size(value: Option<&Value>) -> Option<u16> {
    json_dimension(value)
}

fn live_terminal(state: &AppState, id: &str) -> Option<crate::terminal::TerminalSnapshot> {
    state
        .terminals
        .snapshot(id)
        .filter(|snapshot| !snapshot.exited)
}

fn terminal_gone() -> axum::response::Response {
    (
        StatusCode::NOT_FOUND,
        Json(json!({ "error": "Terminal expired or closed" })),
    )
        .into_response()
}

async fn post_terminal(
    State(state): State<AppState>,
    Path(id): Path<String>,
    request: Request,
) -> impl IntoResponse {
    match post_terminal_inner(&state, &id, request).await {
        Ok(response) => response,
        Err(error) => error.into_response(),
    }
}

async fn post_terminal_inner(
    state: &AppState,
    id: &str,
    request: Request,
) -> AppResult<axum::response::Response> {
    let content_type = request
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    if content_type.starts_with("multipart/form-data") {
        let Some(snapshot) = live_terminal(state, id) else {
            return Ok(terminal_gone());
        };
        let mut multipart = Multipart::from_request(request, &state)
            .await
            .map_err(|_| AppError::msg("Invalid terminal command"))?;
        let mut files = Vec::new();
        let mut bracketed = false;
        while let Some(field) = multipart
            .next_field()
            .await
            .map_err(|e| AppError::msg(e.to_string()))?
        {
            match field.name() {
                Some("bracketed") => {
                    bracketed = field
                        .text()
                        .await
                        .map_err(|e| AppError::msg(e.to_string()))?
                        == "true"
                }
                Some("files") => {
                    let name = field.file_name().unwrap_or("").to_string();
                    let bytes = field
                        .bytes()
                        .await
                        .map_err(|e| AppError::msg(e.to_string()))?;
                    files.push((name, bytes.to_vec()));
                }
                _ => {}
            }
        }
        if let Some(error) = validate_terminal_files(&files) {
            return Ok((StatusCode::BAD_REQUEST, Json(json!({ "error": error }))).into_response());
        }
        let paths = save_terminal_files(&snapshot.cwd, &files).await?;
        return if state
            .terminals
            .write_human(id, terminal_image_paste(&paths, bracketed).as_bytes())
        {
            Ok((StatusCode::OK, Json(json!({ "success": true }))).into_response())
        } else {
            Ok((
                StatusCode::CONFLICT,
                Json(json!({ "error": "Terminal closed while uploading files" })),
            )
                .into_response())
        };
    }
    let bytes = axum::body::to_bytes(request.into_body(), 110 * 1024 * 1024)
        .await
        .map_err(|e| AppError::msg(e.to_string()))?;
    let value: Value = serde_json::from_slice(&bytes).unwrap_or(json!({}));
    match value.get("type").and_then(|v| v.as_str()) {
        Some("images") => {
            if let Some(error) =
                validate_terminal_images(value.get("images").unwrap_or(&json!(null)))
            {
                return Ok(
                    (StatusCode::BAD_REQUEST, Json(json!({ "error": error }))).into_response()
                );
            }
            let Some(snapshot) = live_terminal(state, id) else {
                return Ok(terminal_gone());
            };
            let images = value
                .get("images")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            let paths = save_terminal_images(&snapshot.cwd, &images).await?;
            if state.terminals.write_human(
                id,
                terminal_image_paste(&paths, value.get("bracketed") == Some(&json!(true)))
                    .as_bytes(),
            ) {
                Ok((StatusCode::OK, Json(json!({ "success": true }))).into_response())
            } else {
                Ok((
                    StatusCode::CONFLICT,
                    Json(json!({ "error": "Terminal closed while uploading images" })),
                )
                    .into_response())
            }
        }
        Some("input") => {
            let data = value.get("data").and_then(|v| v.as_str()).unwrap_or("");
            if data.len() > 64 * 1024 {
                return Ok((
                    StatusCode::BAD_REQUEST,
                    Json(json!({ "error": "Invalid terminal command" })),
                )
                    .into_response());
            }
            let written = if value["human"].as_bool() == Some(true) {
                state.terminals.write_human(id, data.as_bytes())
            } else {
                state.terminals.write(id, data)
            };
            if written {
                Ok((StatusCode::OK, Json(json!({ "success": true }))).into_response())
            } else {
                Ok((
                    StatusCode::NOT_FOUND,
                    Json(json!({ "error": "Terminal not found" })),
                )
                    .into_response())
            }
        }
        Some("input_binary") => {
            let data = value.get("data").and_then(Value::as_array);
            let data = data
                .filter(|bytes| bytes.len() <= 64 * 1024)
                .and_then(|bytes| {
                    bytes
                        .iter()
                        .map(|byte| byte.as_u64().and_then(|n| u8::try_from(n).ok()))
                        .collect::<Option<Vec<u8>>>()
                });
            let Some(data) = data else {
                return Ok((
                    StatusCode::BAD_REQUEST,
                    Json(json!({ "error": "Invalid binary terminal input" })),
                )
                    .into_response());
            };
            if state.terminals.write_bytes(id, &data) {
                Ok((StatusCode::OK, Json(json!({ "success": true }))).into_response())
            } else {
                Ok((
                    StatusCode::NOT_FOUND,
                    Json(json!({ "error": "Terminal not found" })),
                )
                    .into_response())
            }
        }
        Some("resize") => {
            let Some(cols) = json_int_size(value.get("cols")) else {
                return Ok((
                    StatusCode::BAD_REQUEST,
                    Json(json!({ "error": "Invalid terminal command" })),
                )
                    .into_response());
            };
            let Some(rows) = json_int_size(value.get("rows")) else {
                return Ok((
                    StatusCode::BAD_REQUEST,
                    Json(json!({ "error": "Invalid terminal command" })),
                )
                    .into_response());
            };
            if state.terminals.resize(id, cols, rows) {
                Ok((StatusCode::OK, Json(json!({ "success": true }))).into_response())
            } else {
                Ok((
                    StatusCode::NOT_FOUND,
                    Json(json!({ "error": "Terminal not found" })),
                )
                    .into_response())
            }
        }
        _ => Ok((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "Invalid terminal command" })),
        )
            .into_response()),
    }
}

async fn delete_terminal(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    crate::debuglog::info_term("pty", &id, "kill");
    crate::debuglog::unbind_term(&id);
    state.terminals.kill(&id);
    Json(json!({ "success": true }))
}

#[derive(Deserialize)]
struct TerminalEventsQuery {
    after: Option<String>,
}

async fn terminal_events(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<TerminalEventsQuery>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let after = headers
        .get("last-event-id")
        .and_then(|v| v.to_str().ok())
        .or(query.after.as_deref())
        .filter(|s| s.chars().all(|c| c.is_ascii_digit()))
        .and_then(|s| s.parse().ok());
    let Some((output, rx, exited, code)) = state.terminals.subscribe(&id, after) else {
        crate::debuglog::warn_term("sse", &id, "subscribe missed (terminal gone)");
        return (StatusCode::NOT_FOUND, "Terminal not found").into_response();
    };
    crate::debuglog::debug_term(
        "sse",
        &id,
        &format!("subscribe after={after:?} exited={exited}"),
    );
    if let TerminalEvent::Output {
        data,
        from,
        offset,
        reset,
        ..
    } = &output
    {
        crate::debuglog::debug_term(
            "sse",
            &id,
            &format!(
                "catchup from={from} to={offset} bytes={} reset={reset:?}",
                data.len()
            ),
        );
    }
    let mut initial = vec![sse_event(&output)];
    if exited {
        initial.push(sse_event(&TerminalEvent::Exit {
            exit_code: code.unwrap_or(0),
        }));
    }
    let stream = stream::iter(initial.into_iter().map(Ok::<_, Infallible>))
        .chain(UnboundedReceiverStream::new(rx).map(|event| Ok(sse_event(&event))));
    Sse::new(stream)
        .keep_alive(KeepAlive::new().interval(Duration::from_secs(30)))
        .into_response()
}

fn sse_event(event: &TerminalEvent) -> Event {
    let id = if let TerminalEvent::Output { offset, .. } = event {
        Some(offset.to_string())
    } else {
        None
    };
    let mut ev =
        Event::default().data(serde_json::to_string(event).unwrap_or_else(|_| "{}".into()));
    if let Some(id) = id {
        ev = ev.id(id);
    }
    ev
}

async fn empty_sessions() -> impl IntoResponse {
    Json(json!({ "sessions": [] }))
}

fn with_cwd(queue: CardQueue, state: &AppState) -> Value {
    let mut value = serde_json::to_value(queue).unwrap_or(json!({}));
    if let Some(obj) = value.as_object_mut() {
        obj.insert("defaultCwd".into(), json!(state.default_cwd));
        // External sessions ride along in the snapshot so the deck can show them
        // without the queue store ever learning they exist.
    }
    value
}

pub async fn start_server(state: AppState) -> AppResult<u16> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    crate::mcp::migrate_legacy_cards(&state).await?;
    crate::mcp::publish(&state, port)?;
    crate::acp_supervisor::start(state.clone());
    crate::inbox::start(state.clone());
    let app = router(state);
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    Ok(port)
}

pub fn build_state(resource_dir: Option<PathBuf>) -> AppState {
    let live = LiveBus::new();
    let settings = Arc::new(SettingsStore::new());
    let _ = settings.load_for_boot();
    // Built before the runtime so the signal watcher can stamp hook latency
    // straight onto the PTY probe (see `TerminalHub::record_first_hook`).
    let terminals = TerminalHub::new(live.clone());
    let bin_dir = resolve_bin_dir(resource_dir);
    AppState {
        queue: Arc::new(QueueStore::new(live.clone())),
        terminals: terminals.clone(),
        harness: AcpRuntime::new(live.clone()),
        hosts: Arc::new(HostStore::new()),
        settings,
        live,
        bin_dir,
        default_cwd: std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
        launches: Arc::new(Mutex::new(HashSet::new())),
        mcp: Arc::new(crate::mcp::McpControl::default()),
        api_token: uuid::Uuid::new_v4().simple().to_string().into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn target(cwd: &str, body: Value) -> AppResult<TerminalTarget> {
        terminal_target(cwd, terminal_ssh_host(&body)?)
    }

    #[test]
    fn a_local_terminal_needs_a_real_directory() {
        let dir = std::env::temp_dir().join("que-terminal-target");
        std::fs::create_dir_all(&dir).expect("temp dir");
        let local = target(dir.to_str().expect("utf-8 path"), json!({}))
            .expect("a real directory is accepted");
        match local {
            TerminalTarget::Local(cwd) => assert_eq!(cwd, dir),
            TerminalTarget::Remote { .. } => panic!("no sshHost means a local terminal"),
        }
        let missing = dir.join("does-not-exist");
        assert!(target(missing.to_str().expect("utf-8 path"), json!({})).is_err());
    }

    #[test]
    fn an_ssh_terminal_takes_the_remote_path_verbatim() {
        // The directory does not exist here, and on Windows `/srv/app` is not
        // even absolute — resolving or stat-ing it would answer about the wrong
        // machine, so anything other than passing it through is a regression.
        let remote = target("/srv/app", json!({ "sshHost": "build-box" }))
            .expect("a remote path is not a local path");
        match remote {
            TerminalTarget::Remote { host, directory } => {
                assert_eq!(host, "build-box");
                assert_eq!(directory, "/srv/app");
            }
            TerminalTarget::Local(_) => panic!("an sshHost means a remote terminal"),
        }
    }

    #[test]
    fn an_ssh_terminal_rejects_a_relative_directory() {
        assert!(target("srv/app", json!({ "sshHost": "build-box" })).is_err());
    }

    #[test]
    fn a_host_is_read_only_from_a_plausible_alias() {
        assert!(matches!(terminal_ssh_host(&json!({})), Ok(None)));
        assert!(matches!(
            terminal_ssh_host(&json!({ "sshHost": "   " })),
            Ok(None)
        ));
        assert_eq!(
            terminal_ssh_host(&json!({ "sshHost": "dev@example.com:2222" }))
                .expect("a user@host alias")
                .as_deref(),
            Some("dev@example.com:2222")
        );
        assert!(terminal_ssh_host(&json!({ "sshHost": "-oProxyCommand=sh" })).is_err());
        assert!(terminal_ssh_host(&json!({ "sshHost": "build box" })).is_err());
    }

    #[test]
    fn the_workspace_editor_and_the_terminal_api_agree_on_hosts() {
        for host in [
            "build-box",
            "dev@example.com",
            "h.example.com:2222",
            "_bad",
            "--flag",
            "",
        ] {
            let expected = regex::Regex::new(r"^[a-zA-Z0-9][a-zA-Z0-9._@:-]*$")
                .expect("reference pattern")
                .is_match(host);
            assert_eq!(valid_ssh_host(host), expected, "disagreement on {host:?}");
        }
    }
}
