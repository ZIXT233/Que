//! Authenticated Que tools for agents and the user's own MCP clients.
//!
//! A message between cards is a turn in the target's ACP session, written in the
//! target's conversation with the sender named in its header. acpx queues it when
//! the target is busy. Answers are ordinary messages back; nothing is relayed
//! automatically. Every card is the user's own, so messaging needs no approval;
//! managing cards and settings needs the permissions the user gave that card.
use crate::api::AppState;
use crate::error::{AppError, AppResult};
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    Json,
};
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    hash::{Hash, Hasher},
    sync::OnceLock,
    time::{Duration, Instant},
};
use sha2::Digest;
use tokio::sync::Mutex;
use uuid::Uuid;

#[derive(Default)]
pub struct McpControl {
    token: OnceLock<String>,
    tools: Mutex<ToolState>,
}
#[derive(Default)]
struct ToolState {
    receipts: VecDeque<(String, Value, Value)>,
    sent: VecDeque<Sent>,
}

/// One accepted card-to-card message, kept for the loop guard.
struct Sent {
    key: String,
    from: String,
    to: String,
    digest: u64,
    at: Instant,
}
const SEND_WINDOW: Duration = Duration::from_secs(600);
const SENDS_PER_WINDOW: usize = 20;

/// Two agents can keep answering each other forever. Like a mail server, the
/// guard is mechanical: an identical message to the same card, or too many
/// messages to one card, within ten minutes is refused. A retried request
/// (same key) is never refused, since it sends nothing new.
fn admit(sent: &mut VecDeque<Sent>, key: &str, from: &str, to: &str, text: &str) -> AppResult<bool> {
    while sent.front().is_some_and(|s| s.at.elapsed() >= SEND_WINDOW) { sent.pop_front(); }
    if sent.iter().any(|s| s.key == key) { return Ok(false); }
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    text.trim().hash(&mut hasher);
    let digest = hasher.finish();
    let to_target = || sent.iter().filter(|s| s.from == from && s.to == to);
    if to_target().any(|s| s.digest == digest) {
        return Err(AppError::msg("The same message was already sent to this card in the last 10 minutes; do not repeat it"));
    }
    if to_target().count() >= SENDS_PER_WINDOW {
        return Err(AppError::msg("Too many messages to this card in 10 minutes; combine them into one message or ask the user"));
    }
    sent.push_back(Sent { key: key.into(), from: from.into(), to: to.into(), digest, at: Instant::now() });
    Ok(true)
}

fn remember(tools: &mut ToolState, key: String, body: Value, result: Value) {
    tools.receipts.push_back((key, body, result));
    while tools.receipts.len() > 128 {
        tools.receipts.pop_front();
    }
}

fn directory() -> std::path::PathBuf {
    crate::paths::data_dir().join("mcp")
}
fn client_config() -> Value {
    json!({"mcpServers":{"que":{"command":"node","args":[directory().join("que-mcp.cjs")]}}})
}

pub fn publish(state: &AppState, port: u16) -> AppResult<()> {
    let dir = directory();
    std::fs::create_dir_all(&dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
    }
    let token = Uuid::new_v4().simple().to_string();
    state
        .mcp
        .token
        .set(token.clone())
        .map_err(|_| AppError::msg("MCP already initialized"))?;
    crate::paths::atomic_write(
        &dir.join("que-mcp.cjs"),
        include_str!("../../scripts/que-mcp.cjs"),
    )?;
    crate::paths::atomic_write(
        &dir.join("client.json"),
        &serde_json::to_string_pretty(&client_config())?,
    )?;
    crate::paths::atomic_write(
        &dir.join("endpoint.json"),
        &serde_json::to_string(&json!({
            "url":format!("http://127.0.0.1:{port}/api/mcp/tools"), "token":token
        }))?,
    )?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(
            dir.join("endpoint.json"),
            std::fs::Permissions::from_mode(0o600),
        )?;
    }
    start_remote_dispatch(state);
    Ok(())
}

// Reverse RPC arrives on the established SSH exec stream. The desktop token
// stays local; source authorization is exactly the same as the local MCP path.
fn start_remote_dispatch(state: &AppState) {
    let mut requests=state.harness.remote_requests();
    let state=state.clone();
    tokio::spawn(async move {
        while let Some(request)=requests.recv().await {
            let state=state.clone();
            tokio::spawn(async move {
                if request.message["event"]=="mcp_connect" {
                    if state.harness.current_link(&request.machine,&request.generation) {
                        if let Ok(queue)=state.queue.read_snapshot() {
                            let cards:Vec<_>=queue.cards.iter().filter_map(|card|card.harness.as_ref())
                                .filter(|h|remote_source_matches(&queue,&request.machine,&h.terminal_id))
                                .map(|h|h.terminal_id.clone()).collect();
                            let _=request.reply.send(format!("{}\n",json!({"action":"_mcp_bind","cards":cards})).into_bytes());
                        }
                    }
                    return;
                }
                let result=tokio::time::timeout(call_budget(&request.message["body"]), remote_tool(&state,&request)).await;
                let result=match result {
                    Ok(Ok(value))=>value,
                    Ok(Err(error))=>json!({"isError":true,"content":[{"type":"text","text":error.to_string()}]}),
                    Err(_)=>json!({"isError":true,"content":[{"type":"text","text":"Que MCP request timed out; execution may be unknown. No automatic retry was made."}]}),
                };
                if state.harness.current_link(&request.machine,&request.generation) {
                    let _=request.reply.send(format!("{}\n",json!({"action":"_mcp_result","requestId":request.message["requestId"],"result":result})).into_bytes());
                }
            });
        }
    });
}
/// How long one tool call may take: a few seconds, or the wait it asked for.
fn call_budget(body:&Value)->Duration {
    if body["tool"]!="wait_messages" {return Duration::from_secs(19);}
    Duration::from_secs(body["timeoutSeconds"].as_u64().unwrap_or(crate::inbox::WAIT_DEFAULT_SECS).clamp(1,crate::inbox::WAIT_MAX_SECS)+5)
}
fn remote_source_matches(queue:&crate::models::CardQueue,machine:&str,source:&str)->bool {
    queue.cards.iter().any(|card|card.archived_at.is_none()
        && card.harness.as_ref().is_some_and(|h|h.terminal_id==source)
        && queue.workspaces.as_ref().is_some_and(|workspaces|workspaces.iter().any(|workspace|
            Some(&workspace.id)==card.workspace_id.as_ref() && workspace.kind=="ssh" && workspace.ssh_host.as_deref()==Some(machine))))
}
async fn remote_tool(state:&AppState, request:&crate::acp::RemoteMcpRequest)->AppResult<Value> {
    if !state.harness.current_link(&request.machine,&request.generation) {return Err(AppError::msg("SSH connection changed; request was not replayed"));}
    let source=required(&request.message,"cardId")?;
    if !remote_source_matches(&state.queue.read_snapshot()?,&request.machine,source) {return Err(AppError::msg("MCP source does not belong to this remote machine"));}
    let mut headers=HeaderMap::new();
    for (key,value) in [
        ("authorization",format!("Bearer {}",state.mcp.token.get().ok_or_else(||AppError::msg("MCP unavailable"))?)),
        ("x-que-client-id",required(&request.message,"clientId")?.to_string()),
        ("x-que-source-terminal",source.to_string()),
        ("x-que-source-epoch",required(&request.message,"epoch")?.to_string()),
    ] {headers.insert(key,value.parse().map_err(|_|AppError::msg("Invalid MCP source header"))?);}
    if !request.message["body"].is_object() || !request.message["body"]["tool"].is_string() {return Err(AppError::msg("Invalid reverse MCP body"));}
    let response=tools_inner(state.clone(),headers,request.message["body"].clone(),Some((&request.machine,&request.generation))).await;
    let failed=!response.status().is_success();
    let bytes=axum::body::to_bytes(response.into_body(),4*1024*1024).await.map_err(|_|AppError::msg("MCP response too large"))?;
    Ok(json!({"isError":failed,"content":[{"type":"text","text":String::from_utf8_lossy(&bytes)}]}))
}

/// Retire old helper cards without deleting their conversations or notes.
pub async fn migrate_legacy_cards(state: &AppState) -> AppResult<()> {
    state
        .queue
        .with_queue(false, |q| {
            for c in &mut q.cards {
                if c.workspace_id
                    .as_deref()
                    .is_some_and(|id| id.starts_with("que-steward-"))
                {
                    c.archived_at.get_or_insert(crate::queue::now_ms());
                    c.phase = crate::models::CardPhase::Attention;
                    c.detached = None;
                    if let Some(h) = c.harness.as_mut() {
                        h.state = "not_running".into();
                    }
                    q.order.retain(|id| id != &c.id);
                }
            }
            q.cards.retain(|c| {
                !(c.workspace_id
                    .as_deref()
                    .is_some_and(|id| id.starts_with("que-steward-"))
                    && c.harness.is_none()
                    && c.session.is_none())
            });
            Ok(())
        })
        .await
}

pub async fn config() -> Json<Value> {
    Json(client_config())
}

pub async fn tools(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    tools_inner(state,headers,body,None).await
}
async fn tools_inner(state:AppState, headers:HeaderMap, body:Value, remote:Option<(&str,&str)>) -> axum::response::Response {
    let operation = body["tool"].as_str().unwrap_or("").to_string();

    let authorized = state.mcp.token.get().is_some_and(|token| {
        headers.get("authorization").and_then(|h| h.to_str().ok())
            == Some(format!("Bearer {token}").as_str())
    });
    if !authorized {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({"error":"MCP client is not authorized"})),
        )
            .into_response();
    }
    let client = headers
        .get("x-que-client-id")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("");
    if Uuid::parse_str(client).is_err() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"Missing MCP client identity"})),
        )
            .into_response();
    }
    let source_terminal = headers
        .get("x-que-source-terminal")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("");
    if !source_terminal.is_empty() && headers.get("x-que-source-epoch").and_then(|h| h.to_str().ok()) != Some(state.harness.epoch(source_terminal).as_str()) {
        return (StatusCode::FORBIDDEN, Json(json!({"error":"Source agent run ended or changed"}))).into_response();
    }
    // Connecting a stopped target is app lifecycle, not an Agent task: do it
    // first, then revalidate the source below.
    if operation == "read_session" {
        if let Some((machine,generation))=remote {
            if !state.harness.current_link(machine,generation)
                || !state.queue.read_snapshot().is_ok_and(|queue|remote_source_matches(&queue,machine,source_terminal)) {
                return (StatusCode::FORBIDDEN,Json(json!({"error":"Remote MCP source or connection changed"}))).into_response();
            }
        }
        if !source_terminal.is_empty() && !state.harness.is_live(source_terminal) {
            return (StatusCode::FORBIDDEN,Json(json!({"error":"Source agent run ended or changed"}))).into_response();
        }
        let card = match required(&body,"cardId") { Ok(card) => card, Err(error) => return error.into_response() };
        // A card is one session: its session id is its own id.
        if let Err(error) = crate::acp_supervisor::ensure_card(&state,card,card).await {
            return error.into_response();
        }
    }
    if let Some((machine,generation))=remote {
        let valid=state.harness.current_link(machine,generation)
            && state.queue.read_snapshot().is_ok_and(|queue|remote_source_matches(&queue,machine,source_terminal));
        if !valid {return (StatusCode::FORBIDDEN,Json(json!({"error":"Remote MCP source or connection changed"}))).into_response();}
    }
    if !source_terminal.is_empty() && headers.get("x-que-source-epoch").and_then(|h| h.to_str().ok()) != Some(state.harness.epoch(source_terminal).as_str()) {
        return (StatusCode::FORBIDDEN, Json(json!({"error":"Source agent run ended or changed"}))).into_response();
    }
    let result = run_tool(&state, &state.mcp.tools, &body, client, source_terminal).await;
    // A busy card reads its mail between tool calls: whatever waits for it
    // rides on this result.
    let mail = match (&result, source_terminal.is_empty() || operation == "wait_messages") {
        (Ok(_), false) => match state.queue.read_snapshot().ok().and_then(|queue| queue.cards.iter()
            .find(|c| c.harness.as_ref().is_some_and(|h| h.terminal_id == source_terminal)).map(|c| c.id.clone())) {
            Some(card) => crate::inbox::hand_over(&state, &card).await.unwrap_or_default(),
            None => Vec::new(),
        },
        _ => Vec::new(),
    };
    match result {
        Ok(value) if mail.is_empty() => Json(value).into_response(),
        Ok(value) => {
            let mut value = if value.is_object() { value } else { json!({"result":value}) };
            value["queMessages"] = crate::inbox::shown(&mail);
            Json(value).into_response()
        }
        Err(error) => error.into_response(),
    }
}

fn required<'a>(body: &'a Value, name: &str) -> AppResult<&'a str> {
    body[name]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::msg(format!("Missing {name}")))
}

fn card_title(
    harness: Option<&crate::models::HarnessSession>,
    workspace_name: Option<&str>,
) -> String {
    let Some(h) = harness else {
        return "新会话".into();
    };
    h.session_name
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| h.first_prompt.as_deref().filter(|s| !s.trim().is_empty()))
        .or_else(|| h.submit_prompt.as_deref().filter(|s| !s.trim().is_empty()))
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| {
            let kind = match h.kind.as_str() {
                "claude" => "Claude Code",
                "cursor" => "Cursor Agent",
                "antigravity" => "Antigravity CLI",
                "codebuddy" => "CodeBuddy",
                "grok" => "Grok Build",
                "shell" => "纯终端，不响应 Agent 事件",
                "codex" => "Codex",
                "opencode" => "OpenCode",
                "pi" => "Pi",
                "omp" => "OMP",
                "devin" => "Devin",
                other => other,
            };
            format!("{kind} · {}", workspace_name.unwrap_or("新会话"))
        })
}

async fn run_tool(
    state: &AppState,
    tools: &Mutex<ToolState>,
    body: &Value,
    client: &str,
    source_terminal: &str,
) -> AppResult<Value> {
    let tool = required(body, "tool")?;
    let queue = state.queue.read_snapshot()?;
    let source_card = if source_terminal.is_empty() {
        None
    } else {
        Some(
            queue
                .cards
                .iter()
                .find(|c| {
                    c.archived_at.is_none()
                        && c.harness
                            .as_ref()
                            .is_some_and(|h| h.terminal_id == source_terminal)
                        && state.harness.is_live(source_terminal)
                })
                .ok_or_else(|| AppError::msg("Source card run ended or changed"))?,
        )
    };
    let principal = source_card
        .map(|c| format!("card:{}:{}", c.id, state.harness.epoch(&c.id)))
        .unwrap_or_else(|| format!("client:{client}"));
    let permissions = source_card.map(|c| c.permissions).unwrap_or_default();
    let manager = permissions.manage_cards;
    let granted = |allowed: bool, what: &str| if allowed { Ok(()) } else {
        Err(AppError::msg(format!("This card may not {what}; the user can allow it on the card")))
    };
    match tool {
        "list_settings" => return Ok(crate::mcp_settings::catalog()),
        "read_settings" | "update_settings" | "create_workspace" | "list_remote_hosts" | "configure_remote_host" => {
            granted(permissions.settings, "read or change settings")?;
            return match tool {
                "read_settings" => crate::mcp_settings::read(state, body).await,
                "update_settings" => crate::mcp_settings::update(state, body).await,
                "create_workspace" => crate::mcp_settings::create_workspace(state, body).await,
                "list_remote_hosts" => Ok(json!({"hosts":state.hosts.list().await?})),
                _ => configure_remote_host(state, body).await,
            };
        }
        "list_workspaces" => return Ok(json!({"workspaces":queue.workspaces.as_ref().map(|items|items.iter().map(|w|json!({"workspaceId":w.id,"name":w.name,"cwd":w.cwd,"kind":w.kind,"sshHost":w.ssh_host})).collect::<Vec<_>>()).unwrap_or_default()})),
        "list_harnesses" => {
            let id = required(body, "workspaceId")?;
            let ws = queue.workspaces.as_ref().and_then(|items| items.iter().find(|w| w.id == id)).ok_or_else(|| AppError::msg("Workspace not found"))?;
            return state.harness.request(&crate::workspace_rc::effective_workspace(&queue, ws), &state.bin_dir, json!({"action":"catalog"})).await;
        }
        "create_card" => return crate::mcp_cards::create(state, source_terminal, source_card.map(|c| c.id.as_str()), manager, body).await,
        "archive_card" => { granted(manager, "archive cards")?; return crate::mcp_cards::archive(state, source_terminal, body).await; }
        "list_cards" => return Ok(list_cards(state, &queue, source_card)),
        "wait_messages" => {
            let source = source_card.ok_or_else(|| AppError::msg("wait_messages is for a card's own Agent"))?;
            let seconds = body["timeoutSeconds"].as_u64().unwrap_or(crate::inbox::WAIT_DEFAULT_SECS);
            let letters = crate::inbox::wait(state, &source.id, seconds).await?;
            return Ok(json!({"queMessages":crate::inbox::shown(&letters),
                "note":if letters.is_empty() { "No message yet. Call again to keep waiting, or finish your turn: messages that arrive later start your next turn." } else { "Each message is handed over once." }}));
        }
        "send_message" => return send_message(state, tools, body, &queue, source_card, &principal).await,
        "read_session" | "cancel_turn" | "set_card_nickname" => {}
        _ => return Err(AppError::msg("Unknown tool")),
    }
    let card_id = required(body, "cardId")?;
    let card = queue
        .cards
        .iter()
        .find(|c| c.id == card_id && c.archived_at.is_none())
        .ok_or_else(|| AppError::msg("Card is missing or archived"))?;
    if tool == "set_card_nickname" {
        if !manager && source_card.is_some_and(|source| source.id != card_id) {
            return Err(AppError::msg("This card may rename only itself; the user can allow it to manage cards"));
        }
        return set_nickname(state, tools, body, client, card_id).await;
    }
    if card.harness.is_none() { return Err(AppError::msg("This card has not started an Agent yet")); }
    if let Some(source) = source_card.filter(|source| source.id != card_id) {
        if tool == "cancel_turn" && !manager {
            return Err(AppError::msg("This card may not stop another card's turn; send it a message to ask it to stop"));
        }
        if !crate::channels::open(&queue, &source.id, card_id) {
            return Err(AppError::msg("No channel with this card. Send it a message: the user is asked to open a channel, and the message goes once they do"));
        }
    }
    let ws = crate::api::acp_workspace(state, card_id).await?;
    if tool == "read_session" {
        let snapshot = state.harness.request(&ws, &state.bin_dir, json!({"action":"read","id":card_id})).await?;
        return Ok(crate::session_view::session_view(card_id, &snapshot, body));
    }
    state.harness.request(&ws, &state.bin_dir, json!({"action":"cancel","id":card_id,"requestId":required(body,"turnId")?})).await
}

/// Puts one message in the inbox of each recipient: listed cards, or `"all"`
/// other cards with an Agent. The sender's conversation shows what it sent.
async fn send_message(state: &AppState, tools: &Mutex<ToolState>, body: &Value, queue: &crate::models::CardQueue,
    source: Option<&crate::models::QueueCard>, principal: &str) -> AppResult<Value> {
    let request_id = required(body, "requestId")?;
    if request_id.len() > 128 { return Err(AppError::msg("requestId is too long")); }
    let text = required(body, "text")?;
    let named: Vec<&str> = match &body["to"] {
        Value::String(id) => vec![id.as_str()],
        Value::Array(ids) => ids.iter().filter_map(Value::as_str).collect(),
        _ => return Err(AppError::msg("to must be a card id, a list of card ids, or \"all\"")),
    };
    let everyone = named.contains(&"all");
    // Without a channel a named card still gets the message, once the user opens one.
    let joined = |card: &crate::models::QueueCard| source.is_none_or(|s| crate::channels::open(queue, &s.id, &card.id));
    let reachable = |c: &&crate::models::QueueCard| c.archived_at.is_none() && c.harness.is_some();
    let mut recipients: Vec<&crate::models::QueueCard> = Vec::new();
    if everyone {
        recipients.extend(queue.cards.iter().filter(reachable).filter(|c| source.is_none_or(|s| s.id != c.id) && joined(c)));
    } else {
        for id in named {
            if source.is_some_and(|s| s.id == id) { return Err(AppError::msg("A card cannot message itself")); }
            let card = queue.cards.iter().filter(reachable).find(|c| c.id == id)
                .ok_or_else(|| AppError::msg(format!("Card {id} is missing, archived or has no Agent; list_cards shows who can be reached")))?;
            if !recipients.iter().any(|r| r.id == card.id) { recipients.push(card); }
        }
    }
    if recipients.is_empty() { return Err(AppError::msg(if everyone { "No card has a channel with you yet" } else { "No card to send to" })); }
    let name = |card: &crate::models::QueueCard| crate::session_view::card_name(card, &state.harness.debug_snapshot(&card.id, &state.terminals));
    let from = match source {
        Some(source) => json!({"cardId":source.id,"name":name(source)}),
        None => json!({"cardId":"","name":"External MCP client"}),
    };
    let (mut sent, mut waiting, mut refused, mut fresh) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    for card in recipients {
        // The request key names each letter, so a retried call posts it once.
        let key = format!("{principal}:{request_id}:{}", card.id);
        match admit(&mut tools.lock().await.sent, &key, principal, &card.id, text) {
            Ok(new) => {
                let id = hex::encode(&sha2::Sha256::digest(key.as_bytes())[..16]);
                let held = !joined(card);
                crate::inbox::post(crate::inbox::Letter { id, to: card.id.clone(), from: from.clone(), text: text.into(), at: crate::queue::now_ms(), held }).await?;
                let who = json!({"cardId":card.id,"name":name(card)});
                if new { fresh.push(who.clone()); }
                if held { waiting.push(who); } else { sent.push(who); }
            }
            Err(error) => refused.push(json!({"cardId":card.id,"error":error.to_string()})),
        }
    }
    if let (Some(source), false) = (source, fresh.is_empty()) {
        crate::inbox::note(state, &source.id, json!({"direction":"out","to":fresh,"all":everyone,"text":text})).await;
    }
    if !waiting.is_empty() { state.live.notify("channels"); }
    if sent.is_empty() && waiting.is_empty() { return Err(AppError::msg(refused[0]["error"].as_str().unwrap_or("Refused").to_string())); }
    Ok(json!({"sent":sent,"waitingForChannel":waiting,"refused":refused,
        "note":"Cards in waitingForChannel get it once the user opens a channel to them; do not resend. Each card reads it now if idle, otherwise at its next Que tool call or when its current turn ends. Answers come back as messages to you: call wait_messages to wait within this turn, or finish your turn and they start your next one. Do not poll read_session for them."}))
}

fn list_cards(state: &AppState, queue: &crate::models::CardQueue, source: Option<&crate::models::QueueCard>) -> Value {
    let cards: Vec<Value> = queue
        .cards
        .iter()
        .filter(|c| c.archived_at.is_none())
        .map(|card| {
            let workspace = queue.workspaces.as_ref()
                .and_then(|workspaces| workspaces.iter().find(|workspace| Some(&workspace.id) == card.workspace_id.as_ref()));
            let h = card
                .harness
                .as_ref()
                .map(|h| {
                    let effective = workspace.map(|workspace| crate::workspace_rc::effective_workspace(queue, workspace));
                    state.harness.snapshot(h, &state.terminals, effective.as_ref())
                });
            json!({"cardId":card.id,"cwd":card.cwd,"phase":card.phase,
            "title":card_title(h.as_ref(), workspace.map(|w| w.name.as_str())),
            "nickname":card.nickname,"sessionTitle":h.as_ref().and_then(|h| h.session_name.as_ref()),
            "workspaceName":workspace.map(|w| &w.name),
            "kind":h.as_ref().map(|h| &h.kind), "state":h.as_ref().map(|h| h.state.as_str()).unwrap_or("not_started"),
            "permissions":card.permissions,
            "channel":source.is_none_or(|s| crate::channels::open(queue, &s.id, &card.id)),
            "remote":h.as_ref().and_then(|h| h.remote),
            "connected":h.as_ref().is_some_and(|h| state.harness.is_live(&h.terminal_id))})
        })
        .collect();
    json!({"cards":cards,"note":"channel: whether you may message and read this card now; a message to a card without one asks the user to open it. not_started cards have no Agent yet and cannot receive messages. Other states only describe the connection: read_session and send_message connect a stopped card by themselves."})
}

async fn configure_remote_host(state: &AppState, body: &Value) -> AppResult<Value> {
    let action = required(body, "operation")?;
    let request = match action {
        "save" => {
            let hostname = required(&body["host"], "hostname")?;
            let existing = state.hosts.list().await?;
            if body["host"]["id"].as_str().is_none_or(|v| v.is_empty()) {
                if let Some(host) = existing.iter().find(|h| h.hostname == hostname && h.user.as_deref().unwrap_or("") == body["host"]["user"].as_str().unwrap_or("") && h.port.unwrap_or(22) as u64 == body["host"]["port"].as_u64().unwrap_or(22)) {
                    return Ok(json!({"host":host,"alreadyExists":true}));
                }
            }
            json!({"action":"save","host":body["host"]})
        }
        "set-visibility" => {
            if !body["visible"].is_boolean() { return Err(AppError::msg("visible must be boolean")); }
            json!({"action":action,"host":required(body,"hostId")?,"visible":body["visible"]})
        }
        _ => return Err(AppError::msg("Unsupported host operation")),
    };
    crate::api::machine_action_inner(state, request).await
}

async fn set_nickname(state: &AppState, tools: &Mutex<ToolState>, body: &Value, client: &str, card_id: &str) -> AppResult<Value> {
    let request_id = required(body, "requestId")?;
    if request_id.len() > 128 {
        return Err(AppError::msg("requestId is too long"));
    }
    let nickname = body["nickname"].as_str().ok_or_else(|| AppError::msg("Missing nickname"))?.trim();
    if nickname.chars().count() > 48 || nickname.chars().any(char::is_control) {
        return Err(AppError::msg("Nickname must be at most 48 characters with no control characters"));
    }
    let request_key = format!("{client}:{request_id}");
    if let Some((_, original, result)) = tools.lock().await.receipts.iter().find(|(id, _, _)| id == &request_key) {
        if original != body {
            return Err(AppError::msg("requestId was already used for another action"));
        }
        return Ok(result.clone());
    }
    let changed = state
        .queue
        .with_queue(false, |queue| {
            let target = queue
                .cards
                .iter_mut()
                .find(|c| c.id == card_id && c.archived_at.is_none())
                .ok_or_else(|| AppError::msg("Card is missing or archived"))?;
            target.nickname = (!nickname.is_empty()).then(|| nickname.to_string());
            Ok(())
        })
        .await;
    let result = match changed {
        Ok(()) => json!({"requestId":request_id,"delivery":"updated","cardId":card_id,"nickname":if nickname.is_empty() { None } else { Some(nickname) }}),
        Err(error) => json!({"requestId":request_id,"delivery":"not-updated","error":error.to_string()}),
    };
    remember(&mut *tools.lock().await, request_key, body.clone(), result.clone());
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn remote_source_is_bound_to_registered_machine_and_active_card() {
        let mut queue=crate::models::CardQueue::empty();
        queue.workspaces=Some(serde_json::from_value(json!([
            {"id":"remote","name":"Remote","kind":"ssh","cwd":"/tmp","runtimeCwd":"/tmp","sshHost":"server-a"},
            {"id":"local","name":"Local","kind":"local","cwd":"/tmp","runtimeCwd":"/tmp"}
        ])).unwrap());
        queue.cards=serde_json::from_value(json!([
            {"id":"remote-card","workspaceId":"remote","cwd":"/tmp","phase":"attention","createdAt":0,"harness":{"kind":"fixture","terminalId":"remote-card","state":"working"}},
            {"id":"local-card","workspaceId":"local","cwd":"/tmp","phase":"attention","createdAt":0,"harness":{"kind":"fixture","terminalId":"local-card","state":"working"}}
        ])).unwrap();
        assert!(remote_source_matches(&queue,"server-a","remote-card"));
        assert!(!remote_source_matches(&queue,"server-b","remote-card"));
        assert!(!remote_source_matches(&queue,"server-a","local-card"));
        assert!(!remote_source_matches(&queue,"server-a","missing"));
        queue.cards[0].archived_at=Some(1);
        assert!(!remote_source_matches(&queue,"server-a","remote-card"));
    }
    #[test]
    fn loop_guard_refuses_repeats_and_floods_but_not_retries() {
        let mut sent = VecDeque::new();
        admit(&mut sent, "a:1", "a", "b", "build it").unwrap();
        admit(&mut sent, "a:1", "a", "b", "build it").expect("a retry of the same request sends nothing new");
        assert!(admit(&mut sent, "a:2", "a", "b", " build it ").is_err(), "the same text again is a loop");
        admit(&mut sent, "c:1", "c", "b", "build it").expect("another sender may say the same");
        admit(&mut sent, "a:3", "a", "d", "build it").expect("another target may hear the same");
        for i in 0..19 { admit(&mut sent, &format!("a:x{i}"), "a", "b", &format!("step {i}")).unwrap(); }
        assert!(admit(&mut sent, "a:y", "a", "b", "one more").is_err(), "twenty messages to one card per window");
        sent.iter_mut().for_each(|s| s.at -= SEND_WINDOW);
        admit(&mut sent, "a:z", "a", "b", "build it").expect("the window moves on");
    }

    #[test]
    fn card_title_follows_the_displayed_session_title_fallbacks() {
        let mut harness: crate::models::HarnessSession = serde_json::from_value(json!({
            "kind":"codex","terminalId":"terminal","state":"attention"
        }))
        .unwrap();
        assert_eq!(card_title(None, Some("Project")), "新会话");
        assert_eq!(
            card_title(Some(&harness), Some("Project")),
            "Codex · Project"
        );
        harness.first_prompt = Some("first".into());
        assert_eq!(card_title(Some(&harness), Some("Project")), "first");
        harness.submit_prompt = Some("latest".into());
        assert_eq!(card_title(Some(&harness), Some("Project")), "first");
        harness.session_name = Some("named".into());
        assert_eq!(card_title(Some(&harness), Some("Project")), "named");
    }
}
