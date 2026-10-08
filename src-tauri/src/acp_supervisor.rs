//! ACP connections belong to the app, not to mounted chat views.
use crate::{api::{AppState, try_acquire_launch}, error::{AppError, AppResult}, models::{CardQueue, QueueCard, QueueWorkspace}};
use serde_json::{json, Value};
use std::{collections::HashMap, time::{Duration, Instant}};
use tokio::{sync::Semaphore, task::JoinSet};
use std::sync::Arc;

#[derive(Clone)]
struct Target { card: QueueCard, workspace: QueueWorkspace }

fn machine(workspace: &QueueWorkspace) -> String {
    workspace.ssh_host.clone().unwrap_or_else(|| "local".into())
}

fn targets(state: &AppState) -> AppResult<Vec<Target>> {
    let queue = state.queue.read_snapshot()?;
    Ok(queue_targets(&queue))
}
fn queue_targets(queue: &CardQueue) -> Vec<Target> {
    queue.cards.iter().filter(|card| card.archived_at.is_none() && card.harness.is_some())
        .filter_map(|card| queue.workspaces.as_ref()?.iter()
            .find(|ws| Some(&ws.id) == card.workspace_id.as_ref())
            .map(|ws| Target { card: card.clone(), workspace: crate::workspace_rc::effective_workspace(queue, ws) }))
        .collect()
}

fn same_target(a: &Target, b: &Target) -> bool {
    a.card.id == b.card.id && a.card.workspace_id == b.card.workspace_id && a.card.cwd == b.card.cwd
        && a.card.harness.as_ref().map(|h| (&h.kind, &h.terminal_id)) == b.card.harness.as_ref().map(|h| (&h.kind, &h.terminal_id))
        && a.workspace.kind == b.workspace.kind && a.workspace.cwd == b.workspace.cwd
        && a.workspace.runtime_cwd == b.workspace.runtime_cwd && a.workspace.ssh_host == b.workspace.ssh_host
        && a.workspace.terminal_rc == b.workspace.terminal_rc && a.workspace.session_env == b.workspace.session_env
}

#[derive(Default)]
struct Retry { failures: u32, after: Option<Instant> }
impl Retry {
    fn ready(&self) -> bool { self.after.is_none_or(|after| Instant::now() >= after) }
    fn failed(&mut self) {
        self.failures = self.failures.saturating_add(1);
        self.after = Some(Instant::now() + retry_delay(self.failures));
    }
}
fn retry_delay(failures: u32) -> Duration {
    Duration::from_secs((5u64 << failures.min(6)).min(300))
}
fn needs_connection(health: &Value, id: &str) -> bool {
    health[id]["connected"] != true && health[id]["busy"] != true
}

async fn connect(state: AppState, captured: Target) -> AppResult<()> {
    // Share admission with explicit launch/resume. Do not move cards, clear
    // errors/history, or send any prompt as a side effect of reconnecting.
    let _guard = try_acquire_launch(&state, &captured.card.id)?;
    connect_guarded(&state, &captured).await
}

async fn connect_guarded(state: &AppState, captured: &Target) -> AppResult<()> {
    if !targets(state)?.iter().any(|current| same_target(current, captured)) {
        return Err(AppError::msg("Card was archived or its session target changed"));
    }
    let id = &captured.card.id;
    let snapshot = state.harness.request(&captured.workspace, &state.bin_dir, json!({
        "action":"ensure", "id":id, "agent":captured.card.harness.as_ref().unwrap().kind,
        "cwd":captured.workspace.cwd, "hostAccess":captured.card.harness.as_ref().unwrap().host_access,
    })).await?;
    // Archive/delete/retarget can race a slow startup. Release only the
    // connection we opened, never a newer connection with the same card id.
    if !targets(state)?.iter().any(|current| same_target(current, captured)) {
        state.harness.request(&captured.workspace, &state.bin_dir, json!({
            "action":"close", "id":id, "expectedConnectionId":snapshot["connectionId"],
        })).await?;
        return Err(AppError::msg("Card was archived or its session target changed"));
    }
    Ok(())
}

// Interactive operations join background startup instead of returning a
// spurious stopped/launch-in-progress error. No MCP tool lock is held here.
pub(crate) async fn ensure_card(state: &AppState, id: &str, session: &str) -> AppResult<()> {
    let captured = targets(state)?.into_iter().find(|target| target.card.id == id
        && target.card.harness.as_ref().is_some_and(|h| h.terminal_id == session))
        .ok_or_else(|| AppError::msg("Card is missing, archived, or its session changed"))?;
    let guard = tokio::time::timeout(Duration::from_secs(190), async {
        loop {
            if let Ok(guard) = try_acquire_launch(state, id) { return guard; }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }).await.map_err(|_| AppError::msg("目标会话仍在连接，请稍后使用同一 requestId 重试；消息尚未发送"))?;
    let result = connect_guarded(state, &captured).await;
    drop(guard);
    result
}

async fn maintain_machine(state: AppState, key: String) {
    let mut transport_retry = Retry::default();
    let mut retries: HashMap<String, Retry> = HashMap::new();
    // Bound startup bursts per host. Every eligible card is eventually opened;
    // there is no cap on retained connections and no idle eviction.
    let slots = Arc::new(Semaphore::new(2));
    loop {
        let current = match targets(&state) {
            Ok(all) => all.into_iter().filter(|target| machine(&target.workspace) == key).collect::<Vec<_>>(),
            Err(_) => { tokio::time::sleep(Duration::from_secs(5)).await; continue; }
        };
        if current.is_empty() { return; }
        retries.retain(|id, _| current.iter().any(|target| target.card.id == *id));
        if transport_retry.ready() {
            // A single lightweight heartbeat per machine, independent of views.
            match state.harness.request(&current[0].workspace, &state.bin_dir, json!({"action":"health", "ids":current.iter().map(|target| &target.card.id).collect::<Vec<_>>()})).await {
                Ok(health) => {
                    transport_retry = Retry::default();
                    let mut jobs = JoinSet::new();
                    for target in current {
                        let id = target.card.id.clone();
                        if !needs_connection(&health, &id) { retries.remove(&id); continue; }
                        if !retries.entry(id.clone()).or_default().ready() { continue; }
                        let state = state.clone(); let slots = slots.clone();
                        jobs.spawn(async move {
                            let _slot = slots.acquire_owned().await.expect("supervisor semaphore");
                            (id, connect(state, target).await)
                        });
                    }
                    while let Some(result) = jobs.join_next().await {
                        if let Ok((id, result)) = result {
                            if result.is_ok() { retries.remove(&id); }
                            else { retries.entry(id).or_default().failed(); }
                        }
                    }
                }
                Err(_) => transport_retry.failed(),
            }
        }
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
}

pub(crate) fn start(state: AppState) {
    tokio::spawn(async move {
        let mut workers = HashMap::<String, tokio::task::JoinHandle<()>>::new();
        loop {
            workers.retain(|_, worker| !worker.is_finished());
            if let Ok(all) = targets(&state) {
                for target in all {
                    let key = machine(&target.workspace);
                    workers.entry(key.clone()).or_insert_with(|| tokio::spawn(maintain_machine(state.clone(), key)));
                }
            }
            // New cards/hosts join without needing a visible conversation.
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn health_does_not_restart_busy_or_connected_agents() {
        let health = json!({"idle":{"connected":true,"busy":false},"working":{"connected":true,"busy":true},
            "starting":{"connected":false,"busy":true},"exited":{"connected":false,"busy":false}});
        for id in ["idle", "working", "starting"] { assert!(!needs_connection(&health,id)); }
        for id in ["exited", "absent"] { assert!(needs_connection(&health,id)); }
    }
    #[test]
    fn only_unarchived_harness_cards_are_warmed_and_identity_changes_are_detected() {
        let mut queue: CardQueue = serde_json::from_value(json!({
            "version":1,"revision":0,"order":[],
            "workspaces":[{"id":"w","name":"test","kind":"local","cwd":"/tmp","runtimeCwd":"/tmp"}],
            "cards":[
                {"id":"live","cwd":"/tmp","workspaceId":"w","createdAt":0,"phase":"attention","harness":{"kind":"codex","terminalId":"live","state":"not_running"}},
                {"id":"archived","cwd":"/tmp","workspaceId":"w","createdAt":0,"phase":"attention","archivedAt":1,"harness":{"kind":"codex","terminalId":"archived","state":"not_running"}},
                {"id":"blank","cwd":"/tmp","workspaceId":"w","createdAt":0,"phase":"draft"}
            ]
        })).unwrap();
        let captured = queue_targets(&queue); assert_eq!(captured.len(),1);
        assert_eq!(captured[0].card.id,"live");
        queue.cards[0].phase = crate::models::CardPhase::Working;
        assert!(same_target(&captured[0],&queue_targets(&queue)[0]),"placement is not connection identity");
        queue.cards[0].harness.as_mut().unwrap().kind = "claude".into();
        assert!(!same_target(&captured[0],&queue_targets(&queue)[0]));
        queue.cards[0].archived_at = Some(1);
        assert!(queue_targets(&queue).is_empty());
    }
    #[test]
    fn retries_back_off_and_are_bounded() {
        assert_eq!(retry_delay(1), Duration::from_secs(10));
        assert_eq!(retry_delay(2), Duration::from_secs(20));
        assert_eq!(retry_delay(1000), Duration::from_secs(300));
        let mut retry = Retry::default(); assert!(retry.ready()); retry.failed(); assert!(!retry.ready());
    }
}
