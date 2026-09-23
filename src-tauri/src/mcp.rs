//! Independent, authenticated terminal tools for external MCP clients.
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
    collections::{HashMap, HashSet, VecDeque},
    sync::OnceLock,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;
use uuid::Uuid;

#[derive(Default)]
pub struct McpControl {
    token: OnceLock<String>,
    tools: Mutex<ToolState>,
}
#[derive(Default)]
struct ToolState {
    reads: HashMap<String, ReadPermit>,
    receipts: VecDeque<(String, Value, Value)>,
    pending: HashMap<String, PendingAccess>,
    grants: HashSet<RunScope>,
    all_cards_grants: HashSet<SourceScope>,
}
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct SourceScope {
    principal: String,
    card: String,
    terminal: String,
}
impl SourceScope {
    fn valid(&self, state: &AppState) -> bool {
        state.terminals.is_live(&self.terminal)
            && state.queue.read_snapshot().is_ok_and(|queue| {
                queue.cards.iter().any(|card| {
                    card.id == self.card
                        && card.archived_at.is_none()
                        && card
                            .harness
                            .as_ref()
                            .is_some_and(|h| h.terminal_id == self.terminal)
                })
            })
    }
}
struct ReadPermit {
    client: String,
    terminal: String,
    revision: u64,
    at: Instant,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct RunScope {
    principal: String,
    source_card: Option<String>,
    source_terminal: String,
    card: String,
    terminal: String,
}
impl RunScope {
    fn valid(&self, state: &AppState) -> bool {
        let Ok(queue) = state.queue.read_snapshot() else {
            return false;
        };
        let live = |card: &str, terminal: &str| {
            queue.cards.iter().any(|c| {
                c.id == card
                    && c.archived_at.is_none()
                    && if terminal.is_empty() {
                        c.harness
                            .as_ref()
                            .is_none_or(|h| !state.terminals.is_live(&h.terminal_id))
                    } else {
                        state.terminals.is_live(terminal)
                            && c.harness
                                .as_ref()
                                .is_some_and(|h| h.terminal_id == terminal)
                    }
            })
        };
        live(&self.card, &self.terminal)
            && self
                .source_card
                .as_ref()
                .is_none_or(|card| live(card, &self.source_terminal))
    }
}

// Capture card and workspace together so approval cannot launch a changed target.
pub(crate) fn launch_target(queue: &crate::models::CardQueue, id: &str) -> Value {
    let card = queue.cards.iter().find(|c| c.id == id);
    let workspace = card.and_then(|c| {
        queue
            .workspaces
            .as_ref()?
            .iter()
            .find(|w| Some(&w.id) == c.workspace_id.as_ref())
    });
    json!({"card":card,"workspace":workspace})
}
struct PendingAccess {
    key: String,
    body: Value,
    scope: RunScope,
    at: Instant,
    expires_at: i64,
    source: String,
    target: String,
}
impl PendingAccess {
    fn valid(&self, state: &AppState) -> bool {
        if self.body["tool"] != "start_card" {
            return self.scope.valid(state);
        }
        let Ok(queue) = state.queue.read_snapshot() else {
            return false;
        };
        let source_live = self.scope.source_card.as_ref().is_none_or(|id| {
            state.terminals.is_live(&self.scope.source_terminal)
                && queue.cards.iter().any(|c| {
                    c.id == *id
                        && c.archived_at.is_none()
                        && c.harness
                            .as_ref()
                            .is_some_and(|h| h.terminal_id == self.scope.source_terminal)
                })
        });
        source_live
            && launch_target(&queue, &self.scope.card) == self.body["_mcpExpected"]
            && !state.terminals.is_live(&self.scope.terminal)
    }
}
fn remember(tools: &mut ToolState, key: String, body: Value, result: Value) {
    tools.receipts.push_back((key, body, result));
    while tools.receipts.len() > 128 {
        tools.receipts.pop_front();
    }
}
fn expire(tools: &mut ToolState) {
    let ids: Vec<_> = tools
        .pending
        .iter()
        .filter(|(_, p)| p.at.elapsed() >= Duration::from_secs(30))
        .map(|(id, _)| id.clone())
        .collect();
    for id in ids {
        if let Some(p) = tools.pending.remove(&id) {
            let result = json!({"requestId":p.body["requestId"],"delivery":"expired","execution":"not-sent"});
            remember(tools, p.key, p.body, result);
        }
    }
}
fn pending_result(id: &str, p: &PendingAccess) -> Value {
    json!({"requestId":p.body["requestId"],"approvalId":id,"delivery":"approval-required","execution":"not-sent",
        "expiresAt":p.expires_at,"next":"Wait for the user to decide in Que, then call get_request_status. A denial applies only to this request. Do not automatically repeat denied requests; a later user-directed attempt may request approval again."})
}
pub async fn pending(state: &AppState) -> Value {
    let mut tools = state.mcp.tools.lock().await;
    expire(&mut tools);
    tools.grants.retain(|scope| scope.valid(state));
    tools.all_cards_grants.retain(|scope| scope.valid(state));
    tools.pending.retain(|_, p| p.valid(state));
    let mut values: Vec<_> = tools
        .pending
        .iter()
        .map(|(id, p)| {
            json!({
                "id":id,"sourceCardId":p.scope.source_card,"scope":"run","source":p.source,"target":p.target,"cardId":p.body["cardId"],
                "tool":p.body["tool"],"kind":p.body["kind"],"text":p.body["text"],"key":p.body["key"],"nickname":p.body["nickname"],
                "submit":p.body["submit"].as_bool().unwrap_or(true),"expiresAt":p.expires_at
            })
        })
        .collect();
    values.sort_by(|a, b| {
        a["expiresAt"]
            .as_i64()
            .cmp(&b["expiresAt"].as_i64())
            .then_with(|| a["id"].as_str().cmp(&b["id"].as_str()))
    });
    json!(values)
}

// Approval is native UI IPC only. It is intentionally not an HTTP/MCP tool.
pub async fn decide(
    state: &AppState,
    id: &str,
    approve: bool,
    all_cards: bool,
) -> AppResult<Value> {
    let mut tools = state.mcp.tools.lock().await;
    expire(&mut tools);
    let p = tools
        .pending
        .remove(id)
        .ok_or_else(|| AppError::msg("Request expired or already handled"))?;
    let body = &p.body;
    let card_id = required(body, "cardId")?;
    let terminal_id = body["terminalId"].as_str().unwrap_or_default();
    if all_cards && (!approve || p.scope.source_card.is_none()) {
        tools.pending.insert(id.to_string(), p);
        return Err(AppError::msg(
            "All-card access requires approval from a source card",
        ));
    }
    if approve && all_cards && p.valid(state) {
        tools.all_cards_grants.insert(SourceScope {
            principal: p.scope.principal.clone(),
            card: p.scope.source_card.clone().unwrap(),
            terminal: p.scope.source_terminal.clone(),
        });
    }
    let result = if !p.valid(state) {
        json!({"requestId":body["requestId"],"delivery":"expired","execution":"not-sent","error":"Source or target run ended or changed"})
    } else if approve && body["tool"] == "start_card" {
        let action = if body["_mcpExpected"]["card"]["harness"].is_null() {
            "harness_start"
        } else if body["_mcpExpected"]["card"]["harness"]["providerSessionId"].is_string() {
            "harness_resume"
        } else {
            "harness_reopen"
        };
        match crate::api::launch_harness(state, body, action).await {
            Ok(queue) => {
                let terminal = queue
                    .cards
                    .iter()
                    .find(|c| c.id == card_id)
                    .and_then(|c| c.harness.as_ref())
                    .ok_or_else(|| AppError::msg("Started terminal is missing"))?;
                let mut scope = p.scope.clone();
                scope.terminal = terminal.terminal_id.clone();
                if scope.valid(state) {
                    tools.grants.insert(scope);
                }
                json!({"requestId":body["requestId"],"delivery":"started","cardId":card_id,"terminalId":terminal.terminal_id,
                    "scope":if all_cards { "source-run-all-cards" } else { "run" },"execution":"unconfirmed","next":"read_terminal using the returned terminalId before sending input"})
            }
            Err(error) => {
                json!({"requestId":body["requestId"],"delivery":"not-started","error":error.to_string(),"execution":"unconfirmed"})
            }
        }
    } else {
        if approve {
            tools.grants.insert(p.scope.clone());
        }
        json!({"requestId":body["requestId"],"delivery":if approve { "authorized" } else { "denied" },"scope":if approve && all_cards { "source-run-all-cards" } else if approve { "run" } else { "request" },"execution":"not-sent",
            "next":"If authorized, retry the original tool. Authorization itself does not send input."})
    };
    crate::debuglog::info_card(
        "mcp",
        card_id,
        Some(terminal_id),
        &format!(
            "approval={id} decision={approve} delivery={}",
            result["delivery"]
        ),
    );
    remember(&mut tools, p.key, p.body, result.clone());
    Ok(result)
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
    Ok(())
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
    let mut tools = state.mcp.tools.lock().await;
    expire(&mut tools);
    match run_tool(&state, &mut tools, &body, client, source_terminal).await {
        Ok(value) => Json(value).into_response(),
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
        .or_else(|| h.submit_prompt.as_deref().filter(|s| !s.trim().is_empty()))
        .or_else(|| h.first_prompt.as_deref().filter(|s| !s.trim().is_empty()))
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

fn source_scope(
    source_card: Option<&crate::models::QueueCard>,
    principal: &str,
    terminal: &str,
) -> Option<SourceScope> {
    source_card.map(|card| SourceScope {
        principal: principal.into(),
        card: card.id.clone(),
        terminal: terminal.into(),
    })
}

fn source_label(card: &crate::models::QueueCard) -> String {
    let name = card
        .nickname
        .as_deref()
        .or_else(|| {
            card.harness
                .as_ref()
                .and_then(|h| h.session_name.as_deref())
        })
        .or_else(|| card.harness.as_ref().map(|h| h.kind.as_str()))
        .unwrap_or("新会话");
    format!("MCP · {name} · {}", card.cwd)
}

async fn run_tool(
    state: &AppState,
    tools: &mut ToolState,
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
                        && state.terminals.is_live(source_terminal)
                })
                .ok_or_else(|| AppError::msg("Source card run ended or changed"))?,
        )
    };
    let principal = source_card
        .map(|c| format!("card:{}:{source_terminal}", c.id))
        .unwrap_or_else(|| format!("client:{client}"));
    tools.grants.retain(|scope| scope.valid(state));
    tools.all_cards_grants.retain(|scope| scope.valid(state));
    let all_cards = source_scope(source_card, &principal, source_terminal)
        .is_some_and(|scope| tools.all_cards_grants.contains(&scope));
    if tool == "get_request_status" {
        let request = required(body, "requestId")?;
        let keys = [
            format!("{client}:{request}"),
            format!("{principal}:{request}"),
        ];
        if let Some((_, _, result)) = tools.receipts.iter().find(|(id, _, _)| keys.contains(id)) {
            return Ok(result.clone());
        }
        if let Some((id, p)) = tools.pending.iter().find(|(_, p)| keys.contains(&p.key)) {
            return Ok(pending_result(id, p));
        }
        return Err(AppError::msg(
            "Request unknown or expired from cache; read target before any new action",
        ));
    }
    if tool == "list_cards" {
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
                        let effective = workspace.map(|workspace| crate::workspace_rc::effective_workspace(&queue, workspace));
                        state.harness.snapshot(h, &state.terminals, effective.as_ref())
                    });
                json!({"cardId":card.id,"cwd":card.cwd,"phase":card.phase,
                "title":card_title(h.as_ref(), workspace.map(|w| w.name.as_str())),
                "nickname":card.nickname,"sessionTitle":h.as_ref().and_then(|h| h.session_name.as_ref()),
                "sessionId":h.as_ref().and_then(|h| h.provider_session_id.as_ref()),
                "workspaceName":workspace.map(|w| &w.name),
                "kind":h.as_ref().map(|h| &h.kind), "state":h.as_ref().map(|h| h.state.as_str()).unwrap_or("not_started"),
                "stateNote": "not_started: blank card; not_running: no attached process, awaiting start or recovery; not proof of failure or remote job exit",
                "terminalId":h.as_ref().map(|h| &h.terminal_id),
                "remote":h.as_ref().and_then(|h| h.remote),
                "controllable":h.as_ref().is_some_and(|h| state.terminals.is_live(&h.terminal_id))})
            })
            .collect();
        return Ok(json!({"cards":cards}));
    }
    let card_id = required(body, "cardId")?;

    let card = queue
        .cards
        .iter()
        .find(|c| c.id == card_id && c.archived_at.is_none())
        .ok_or_else(|| AppError::msg("Card is missing or archived"))?;
    if tool == "start_card" {
        let request_id = required(body, "requestId")?;
        if request_id.len() > 128 {
            return Err(AppError::msg("requestId is too long"));
        }
        let key = format!("{principal}:{request_id}");
        if let Some((_, original, result)) = tools.receipts.iter().find(|(id, _, _)| id == &key) {
            if original["_original"] != *body {
                return Err(AppError::msg(
                    "requestId was already used for another action",
                ));
            }
            return Ok(result.clone());
        }
        if let Some((id, p)) = tools.pending.iter().find(|(_, p)| p.key == key) {
            if p.body["_original"] != *body {
                return Err(AppError::msg(
                    "requestId was already used for another action",
                ));
            }
            return Ok(pending_result(id, p));
        }
        if card
            .harness
            .as_ref()
            .is_some_and(|h| state.terminals.is_live(&h.terminal_id))
        {
            return Ok(
                json!({"delivery":"already-running","cardId":card_id,"terminalId":card.harness.as_ref().unwrap().terminal_id}),
            );
        }
        let kind = card
            .harness
            .as_ref()
            .map(|h| h.kind.as_str())
            .or_else(|| body["kind"].as_str())
            .filter(|k| !k.is_empty())
            .ok_or_else(|| AppError::msg("Specify kind when starting a blank card"))?;
        if body["kind"].as_str().is_some_and(|k| k != kind) {
            return Err(AppError::msg(
                "A stopped card must retain its existing harness kind",
            ));
        }
        if all_cards {
            let launch = json!({"id":card_id,"cardId":card_id,"kind":kind});
            let action = if card.harness.is_none() {
                "harness_start"
            } else if card
                .harness
                .as_ref()
                .is_some_and(|h| h.provider_session_id.is_some())
            {
                "harness_resume"
            } else {
                "harness_reopen"
            };
            let result = match crate::api::launch_harness(state, &launch, action).await {
                Ok(queue) => {
                    let terminal = queue
                        .cards
                        .iter()
                        .find(|c| c.id == card_id)
                        .and_then(|c| c.harness.as_ref())
                        .ok_or_else(|| AppError::msg("Started terminal is missing"))?;
                    json!({"requestId":request_id,"delivery":"started","cardId":card_id,"terminalId":terminal.terminal_id,
                        "scope":"source-run-all-cards","execution":"unconfirmed","next":"read_terminal using the returned terminalId before sending input"})
                }
                Err(error) => {
                    json!({"requestId":request_id,"delivery":"not-started","error":error.to_string(),"execution":"unconfirmed"})
                }
            };
            remember(tools, key, json!({"_original":body}), result.clone());
            return Ok(result);
        }
        let scope = RunScope {
            principal,
            source_card: source_card.map(|c| c.id.clone()),
            source_terminal: source_terminal.into(),
            card: card_id.into(),
            terminal: card
                .harness
                .as_ref()
                .map(|h| h.terminal_id.clone())
                .unwrap_or_default(),
        };
        if let Some((id, pending)) = tools
            .pending
            .iter()
            .find(|(_, p)| p.scope == scope && p.body["tool"] == "start_card")
        {
            if pending.body["kind"] != kind {
                return Err(AppError::msg(
                    "A different start request is pending for this card",
                ));
            }
            return Ok(pending_result(id, pending));
        }
        if tools.pending.len() >= 16 {
            return Err(AppError::msg("Too many pending approvals"));
        }
        let pending = PendingAccess {
            key,
            body: json!({"tool":"start_card","id":card_id,"cardId":card_id,"terminalId":scope.terminal,"kind":kind,
                "requestId":request_id,"_original":body,"_mcpExpected":launch_target(&queue, card_id)}),
            scope,
            at: Instant::now(),
            expires_at: crate::queue::now_ms() + 30_000,
            source: source_card
                .map(source_label)
                .unwrap_or_else(|| "External MCP client".into()),
            target: format!("{kind} · {}", card.cwd),
        };
        let id = Uuid::new_v4().to_string();
        let result = pending_result(&id, &pending);
        tools.pending.insert(id, pending);
        state.live.notify("mcp-approval");
        return Ok(result);
    }
    let nickname_tool = tool == "set_card_nickname";
    let terminal_id = if nickname_tool {
        card.harness
            .as_ref()
            .filter(|h| state.terminals.is_live(&h.terminal_id))
            .map(|h| h.terminal_id.as_str())
            .unwrap_or("")
    } else {
        required(body, "terminalId")?
    };
    if !nickname_tool && card.harness.as_ref().map(|h| h.terminal_id.as_str()) != Some(terminal_id)
    {
        return Err(AppError::msg(
            "The card's terminal changed; list cards again",
        ));
    }
    if !matches!(
        tool,
        "read_terminal" | "observe_terminal" | "send_text" | "send_key" | "set_card_nickname"
    ) {
        return Err(AppError::msg("Unknown terminal tool"));
    }
    if nickname_tool {
        if required(body, "requestId")?.len() > 128 {
            return Err(AppError::msg("requestId is too long"));
        }
        let nickname = body["nickname"]
            .as_str()
            .ok_or_else(|| AppError::msg("Missing nickname"))?
            .trim();
        if nickname.chars().count() > 48 || nickname.chars().any(char::is_control) {
            return Err(AppError::msg(
                "Nickname must be at most 48 characters with no control characters",
            ));
        }
    }
    let scope = RunScope {
        principal: principal.clone(),
        source_card: source_card.map(|c| c.id.clone()),
        source_terminal: source_terminal.into(),
        card: card_id.into(),
        terminal: terminal_id.into(),
    };
    if !scope.valid(state) {
        return Err(AppError::msg("Source or target run ended or changed"));
    }
    if !all_cards && !tools.grants.contains(&scope) {
        if let Some((id, pending)) = tools.pending.iter().find(|(_, p)| p.scope == scope) {
            return Ok(pending_result(id, pending));
        }
        if tools.pending.len() >= 16 {
            return Err(AppError::msg("Too many pending approvals"));
        }
        let id = Uuid::new_v4().to_string();
        let request_id = Uuid::new_v4().to_string();
        let pending = PendingAccess {
            key: format!("{principal}:{request_id}"),
            body: json!({"requestId":request_id,"cardId":card_id,"terminalId":terminal_id,"tool":tool,"nickname":body["nickname"]}),
            scope,
            at: Instant::now(),
            expires_at: crate::queue::now_ms() + 30_000,
            source: source_card
                .map(source_label)
                .unwrap_or_else(|| "External MCP client".into()),
            target: format!(
                "{} · {}",
                card.nickname
                    .as_deref()
                    .or_else(|| card
                        .harness
                        .as_ref()
                        .and_then(|h| h.session_name.as_deref()))
                    .or_else(|| card.harness.as_ref().map(|h| h.kind.as_str()))
                    .unwrap_or("新会话"),
                card.cwd
            ),
        };
        let result = pending_result(&id, &pending);
        tools.pending.insert(id, pending);
        state.live.notify("mcp-approval");
        return Ok(result);
    }
    match tool {
        "set_card_nickname" => {
            let request_id = required(body, "requestId")?;
            if request_id.len() > 128 {
                return Err(AppError::msg("requestId is too long"));
            }
            let request_key = format!("{client}:{request_id}");
            if let Some((_, original, result)) =
                tools.receipts.iter().find(|(id, _, _)| id == &request_key)
            {
                if original != body {
                    return Err(AppError::msg(
                        "requestId was already used for another action",
                    ));
                }
                return Ok(result.clone());
            }
            let nickname = body["nickname"].as_str().unwrap().trim();
            let changed = state
                .queue
                .with_queue(false, |queue| {
                    if scope.source_card.as_ref().is_some_and(|id| {
                        !state.terminals.is_live(source_terminal)
                            || !queue.cards.iter().any(|c| {
                                c.id == *id
                                    && c.archived_at.is_none()
                                    && c.harness
                                        .as_ref()
                                        .is_some_and(|h| h.terminal_id == source_terminal)
                            })
                    }) {
                        return Err(AppError::msg("Source run changed"));
                    }
                    let target = queue
                        .cards
                        .iter_mut()
                        .find(|c| c.id == card_id && c.archived_at.is_none())
                        .ok_or_else(|| AppError::msg("Card is missing or archived"))?;
                    let current = target
                        .harness
                        .as_ref()
                        .filter(|h| state.terminals.is_live(&h.terminal_id))
                        .map(|h| h.terminal_id.as_str())
                        .unwrap_or("");
                    if current != terminal_id {
                        return Err(AppError::msg("Target run changed"));
                    }
                    target.nickname = (!nickname.is_empty()).then(|| nickname.to_string());
                    Ok(())
                })
                .await;
            let result = match changed {
                Ok(()) => {
                    json!({"requestId":request_id,"delivery":"updated","cardId":card_id,"nickname":if nickname.is_empty() { None } else { Some(nickname) }})
                }
                Err(error) => {
                    json!({"requestId":request_id,"delivery":"not-updated","error":error.to_string()})
                }
            };
            remember(tools, request_key, body.clone(), result.clone());
            Ok(result)
        }
        "read_terminal" | "observe_terminal" => {
            let read = state
                .terminals
                .read_for_mcp(terminal_id)
                .ok_or_else(|| AppError::msg("Terminal no longer exists"))?;
            let offset = read.offset;
            let revision = read.input_revision;
            let content = tokio::task::spawn_blocking(move || {
                let mut parser = vt100::Parser::new(read.rows, read.cols, 0);
                parser.process(read.data.as_bytes());
                json!({"screen":parser.screen().contents(), "cols":read.cols,"rows":read.rows,
                    "offset":read.offset,"retainedFrom":read.from,"partial":read.from != 0 || read.dimensions_clamped,
                    "exited":read.exited,"source":"reconstructed-terminal-output"})
            }).await.map_err(|e| AppError::msg(e.to_string()))?;
            tools
                .reads
                .retain(|_, p| p.at.elapsed() < Duration::from_secs(30));
            if tools.reads.len() >= 128 {
                tools.reads.clear();
            }
            let permit = Uuid::new_v4().simple().to_string();
            tools.reads.insert(
                permit.clone(),
                ReadPermit {
                    client: client.into(),
                    terminal: terminal_id.into(),
                    revision,
                    at: Instant::now(),
                },
            );
            Ok(json!({"terminal":content,"readToken":permit,
                "outputChanged":body["after"].as_u64().map(|after| offset > after),
                "note":"Output changes may be echo or redraw. They do not prove command completion. A partial screen may omit earlier terminal state."}))
        }
        "send_text" | "send_key" => {
            let request_id = required(body, "requestId")?;
            if request_id.len() > 128 {
                return Err(AppError::msg("requestId is too long"));
            }
            let request_key = format!("{client}:{request_id}");
            if let Some((_, original, result)) =
                tools.receipts.iter().find(|(id, _, _)| id == &request_key)
            {
                if original != body {
                    return Err(AppError::msg(
                        "requestId was already used for another action",
                    ));
                }
                return Ok(result.clone());
            }
            let token = required(body, "readToken")?;
            let permit = tools
                .reads
                .get(token)
                .ok_or_else(|| AppError::msg("Read the target terminal before sending input"))?;
            if permit.client != client
                || permit.terminal != terminal_id
                || permit.at.elapsed() > Duration::from_secs(30)
            {
                return Err(AppError::msg(
                    "Read token expired or belongs to another terminal",
                ));
            }
            let revision = permit.revision;
            let input = tool_input(body)?;
            tools.reads.remove(token);
            let before = state.terminals.probe(terminal_id).map(|t| t.offset);
            let sent = state
                .queue
                .with_queue(true, |q| {
                    let bound = |id: &str, terminal: &str| {
                        q.cards.iter().any(|c| {
                            c.id == id
                                && c.archived_at.is_none()
                                && c.harness
                                    .as_ref()
                                    .is_some_and(|h| h.terminal_id == terminal)
                        })
                    };
                    if !bound(card_id, terminal_id)
                        || scope.source_card.as_ref().is_some_and(|id| {
                            !bound(id, source_terminal) || !state.terminals.is_live(source_terminal)
                        })
                    {
                        return Err(AppError::msg("Source or target run changed"));
                    }
                    state.terminals.write_mcp(terminal_id, revision, &input)
                })
                .await;
            let result = match sent {
                Ok(()) => {
                    json!({"requestId":body["requestId"],"delivery":"written","terminalId":terminal_id,"beforeOffset":before,"execution":"unconfirmed","next":"observe_terminal and inspect output"})
                }
                Err(e) => {
                    json!({"requestId":body["requestId"],"delivery":"not-confirmed","error":e.to_string(),"execution":"unconfirmed"})
                }
            };
            remember(tools, request_key, body.clone(), result.clone());
            Ok(result)
        }
        _ => Err(AppError::msg("Unknown terminal tool")),
    }
}

fn tool_input(body: &Value) -> AppResult<String> {
    if body["tool"] == "send_key" {
        return match required(body, "key")? {
            "Enter" => Ok("\r".into()),
            "Escape" => Ok("\x1b".into()),
            "CtrlC" => Ok("\x03".into()),
            _ => Err(AppError::msg("Supported keys: Enter, Escape, CtrlC")),
        };
    }
    let text = required(body, "text")?;
    if text.len() > 16_384 || text.chars().any(char::is_control) {
        return Err(AppError::msg("Send one line of plain text, up to 16 KiB"));
    }
    Ok(format!(
        "{text}{}",
        if body["submit"].as_bool().unwrap_or(true) {
            "\r"
        } else {
            ""
        }
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn expired_approval_cannot_become_input() {
        let mut tools = ToolState::default();
        tools.pending.insert(
            "old".into(),
            PendingAccess {
                key: "client:request".into(),
                body: json!({"requestId":"request"}),
                scope: RunScope {
                    principal: "test".into(),
                    source_card: None,
                    source_terminal: "".into(),
                    card: "test".into(),
                    terminal: "test".into(),
                },
                at: Instant::now() - Duration::from_secs(31),
                expires_at: 0,
                source: "test".into(),
                target: "test".into(),
            },
        );
        expire(&mut tools);
        assert!(tools.pending.is_empty());
        assert_eq!(tools.receipts[0].2["delivery"], "expired");
        assert_eq!(tools.receipts[0].2["execution"], "not-sent");
    }

    #[test]
    fn terminal_actions_cannot_smuggle_control_sequences() {
        assert!(tool_input(&json!({"tool":"send_text","text":"hi\u{1b}[3J"})).is_err());
        assert!(tool_input(&json!({"tool":"send_text","text":"a\nb"})).is_err());
        assert_eq!(
            tool_input(&json!({"tool":"send_text","text":"你好"})).unwrap(),
            "你好\r"
        );
        assert_eq!(
            tool_input(&json!({"tool":"send_key","key":"CtrlC"})).unwrap(),
            "\x03"
        );
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
        assert_eq!(card_title(Some(&harness), Some("Project")), "latest");
        harness.session_name = Some("named".into());
        assert_eq!(card_title(Some(&harness), Some("Project")), "named");
    }
}
