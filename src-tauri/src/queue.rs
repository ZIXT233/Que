use crate::error::{AppError, AppResult};
use crate::live::LiveBus;
use crate::models::{CardPhase, CardQueue, QueueCard, QueueWorkspace};
use crate::paths::{atomic_write, queue_file};
use crate::terminal::TerminalHub;
use serde_json::Value;
use std::collections::HashSet;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex;
use uuid::Uuid;

pub const TAB_LEASE_MS: i64 = 120_000;

pub struct QueueStore {
    lock: Mutex<()>,
    live: LiveBus,
}

impl QueueStore {
    pub fn new(live: LiveBus) -> Self {
        Self {
            lock: Mutex::new(()),
            live,
        }
    }

    pub fn read_snapshot(&self) -> AppResult<CardQueue> {
        read_queue()
    }

    pub async fn with_queue<T>(
        &self,
        silent: bool,
        action: impl FnOnce(&mut CardQueue) -> AppResult<T>,
    ) -> AppResult<T> {
        let _guard = self.lock.lock().await;
        let mut state = read_queue()?;
        let before = serde_json::to_string(&state)?;
        let result = action(&mut state)?;
        let after = serde_json::to_string(&state)?;
        if after != before {
            state.revision += 1;
            atomic_write(&queue_file(), &serde_json::to_string_pretty(&state)?)?;
            if !silent {
                self.live.notify("queue");
            }
        }
        Ok(result)
    }
}

fn read_queue() -> AppResult<CardQueue> {
    match std::fs::read_to_string(queue_file()) {
        Ok(raw) => {
            let mut state: CardQueue = serde_json::from_str(&raw)?;
            if state.version != 1 {
                return Err(AppError::msg("Invalid card queue file"));
            }
            if state.turn_tags_enabled.is_none() {
                state.turn_tags_enabled = Some(false);
            }
            if state.sort_mode.is_none() {
                state.sort_mode = Some("score".into());
            }
            if state.insertion_position.is_none() {
                state.insertion_position = Some("bottom".into());
            }
            if state.workspaces.is_none() {
                state.workspaces = Some(vec![]);
            }
            Ok(state)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(CardQueue::empty()),
        Err(error) => Err(error.into()),
    }
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn legacy_placement_does_not_override_agent_state() {
        let mut state = CardQueue::empty();
        state.cards = vec![
            serde_json::from_value(json!({
                "id": "running", "cwd": "/tmp", "phase": "attention", "createdAt": 0,
                "harness": {"kind": "codex", "terminalId": "running", "state": "working", "version": "1"},
                "manualPlacement": {"background": false, "terminalId": "running", "observedState": "working"}
            })).unwrap(),
            serde_json::from_value(json!({
                "id": "waiting", "cwd": "/tmp", "phase": "working", "createdAt": 0,
                "harness": {"kind": "codex", "terminalId": "waiting", "state": "attention", "version": "1"},
                "manualPlacement": {"background": true, "terminalId": "waiting", "observedState": "attention"}
            })).unwrap(),
        ];
        state.order = vec!["running".into()];

        reconcile(&mut state);

        assert!(matches!(state.cards[0].phase, CardPhase::Working));
        assert!(matches!(state.cards[1].phase, CardPhase::Attention));
        assert_eq!(state.order, vec!["waiting".to_string()]);
        for card in &state.cards {
            assert!(serde_json::to_value(card).unwrap().get("manualPlacement").is_none());
        }
    }
}

pub fn reconcile(state: &mut CardQueue) {
    let now = now_ms();
    for card in &mut state.cards {
        if let Some(detached) = &card.detached {
            if detached.expires_at <= now {
                card.detached = None;
            }
        }
        let phase = if let Some(harness) = &card.harness {
            if harness.state == "working" {
                CardPhase::Working
            } else {
                CardPhase::Attention
            }
        } else {
            CardPhase::Attention
        };
        if card.archived_at.is_some() {
            if matches!(phase, CardPhase::Working) {
                card.archived_at = None;
            } else {
                state.order.retain(|id| id != &card.id);
                continue;
            }
        }
        if matches!(phase, CardPhase::Working) {
            state.order.retain(|id| id != &card.id);
            card.ready_at = None;
            card.waiting_since = None;
            card.turn_key = None;
            card.turn_tags = None;
            card.tag_evaluation = None;
            card.urgent_call = None;
            card.remind_at = None;
        } else if let Some(remind_at) = card.remind_at {
            if remind_at <= now {
                // The reminder expired: wake the card up and re-enter the queue
                // at the position implied by the active sort mode. In score mode
                // the Wait clock restarts so the card competes by its fresh score.
                card.remind_at = None;
                if state.sort_mode.as_deref() == Some("score") {
                    card.waiting_since = Some(now);
                }
                let id = card.id.clone();
                if !state.order.contains(&id) {
                    card.ready_at.get_or_insert(now);
                    if state.insertion_position.as_deref() == Some("top") {
                        state.order.insert(0, id);
                    } else {
                        state.order.push(id);
                    }
                }
            } else {
                // Still parked: a remind card never sits in the queue order.
                let id = card.id.clone();
                state.order.retain(|item| item != &id);
            }
        } else if !state.order.contains(&card.id) {
            card.ready_at.get_or_insert(now);
            if state.insertion_position.as_deref() == Some("top") {
                state.order.insert(0, card.id.clone());
            } else {
                state.order.push(card.id.clone());
            }
        }
        if matches!(phase, CardPhase::Attention) {
            card.ready_at.get_or_insert(now);
        }
        card.phase = phase;
    }
    let known: HashSet<_> = state
        .cards
        .iter()
        .filter(|c| !matches!(c.phase, CardPhase::Working))
        .map(|c| c.id.clone())
        .collect();
    let mut seen = HashSet::new();
    state
        .order
        .retain(|id| known.contains(id) && seen.insert(id.clone()));
}

pub fn move_card(state: &mut CardQueue, id: &str, position: &str) {
    let Some(card) = state.cards.iter_mut().find(|c| c.id == id) else {
        return;
    };
    if matches!(card.phase, CardPhase::Working) {
        return;
    }
    card.archived_at = None;
    state.order.retain(|item| item != id);
    if position == "front" {
        state.order.insert(0, id.to_string());
    } else {
        state.order.push(id.to_string());
    }
}

pub fn archive_card(state: &mut CardQueue, id: &str) -> AppResult<()> {
    let card = state
        .cards
        .iter_mut()
        .find(|c| c.id == id)
        .ok_or_else(|| AppError::msg("卡片已不存在"))?;
    if card.session.is_none() && card.harness.is_none() {
        return Err(AppError::msg("空白卡片无需归档"));
    }
    if matches!(card.phase, CardPhase::Working) || card.detached.is_some() {
        return Err(AppError::msg("请先结束工作并收回卡片"));
    }
    card.archived_at = Some(now_ms());
    state.order.retain(|item| item != id);
    Ok(())
}

/// Put a queue card into the "remind me later" parking list until `remind_at`.
pub fn park_remind(state: &mut CardQueue, id: &str, remind_at: i64) -> bool {
    let Some(card) = state.cards.iter_mut().find(|c| c.id == id) else {
        return false;
    };
    if (card.session.is_none() && card.harness.is_none())
        || matches!(card.phase, CardPhase::Working)
        || card.archived_at.is_some()
    {
        return false;
    }
    card.remind_at = Some(remind_at);
    state.order.retain(|item| item != id);
    true
}

/// Wake a remind-later card and re-enter it into the queue at the position
/// implied by the active sort mode: score mode restarts the Wait clock so the
/// card competes by its fresh score; FIFO re-inserts at the insertion edge.
pub fn release_remind(state: &mut CardQueue, id: &str) -> bool {
    let Some(card) = state.cards.iter_mut().find(|c| c.id == id) else {
        return false;
    };
    if card.remind_at.is_none() {
        return false;
    }
    card.remind_at = None;
    if state.sort_mode.as_deref() == Some("score") {
        card.waiting_since = Some(now_ms());
    }
    card.ready_at.get_or_insert(now_ms());
    if !state.order.iter().any(|item| item == id) {
        if state.insertion_position.as_deref() == Some("top") {
            state.order.insert(0, id.to_string());
        } else {
            state.order.push(id.to_string());
        }
    }
    true
}

/// Adds card `id` to `workspace`, with its agent chosen and not yet started.
/// A card exists only once its agent is chosen: there are no blank cards.
pub fn new_card(state: &mut CardQueue, id: &str, workspace: &QueueWorkspace, kind: &str, nickname: Option<&str>) -> AppResult<()> {
    let card: QueueCard = serde_json::from_value(serde_json::json!({
        "id": id, "cwd": workspace.runtime_cwd, "workspaceId": workspace.id, "nickname": nickname,
        "priorityWeight": workspace.default_conversation_weight.unwrap_or(0),
        "phase": "attention", "createdAt": now_ms(),
        "harness": { "kind": kind, "terminalId": id, "state": "not_running", "remote": workspace.kind == "ssh" },
    }))?;
    state.cards.push(card);
    state.order.push(id.into());
    Ok(())
}

pub fn numeric_weight(value: &Value) -> i64 {
    value
        .as_i64()
        .or_else(|| value.as_f64().map(|n| n as i64))
        .unwrap_or(0)
        .clamp(-99, 99)
}

pub fn sync_queue(state: &mut CardQueue, terminals: &TerminalHub) {
    state.workspaces.get_or_insert_with(Vec::new);
    if state.sort_mode.is_none() {
        state.sort_mode = Some("score".into());
        state.insertion_position = Some("bottom".into());
    }
    state
        .insertion_position
        .get_or_insert_with(|| "bottom".into());
    for card in &mut state.cards {
        if card.workspace_id.is_some() {
            continue;
        }
        let workspaces = state.workspaces.get_or_insert_with(Vec::new);
        let existing = workspaces
            .iter()
            .find(|w| w.runtime_cwd == card.cwd)
            .map(|w| w.id.clone());
        if let Some(id) = existing {
            card.workspace_id = Some(id);
        } else {
            let id = Uuid::new_v4().to_string();
            let name = card
                .cwd
                .rsplit(['/', '\\'])
                .find(|s| !s.is_empty())
                .unwrap_or(&card.cwd)
                .to_string();
            workspaces.push(QueueWorkspace {
                terminal_rc: None,
                session_env: Default::default(),
                id: id.clone(),
                name,
                kind: "local".into(),
                cwd: card.cwd.clone(),
                ssh_host: None,
                runtime_cwd: card.cwd.clone(),
                default_conversation_weight: None,
            });
            card.workspace_id = Some(id);
        }
    }
    for card in &mut state.cards {
        if let Some(harness) = card.harness.as_mut() {
            if let Some(snapshot) = terminals.snapshot(&harness.terminal_id) {
                if snapshot.exited {
                    harness.exit_code = snapshot.exit_code;
                }
            }
            if let Some(next) = terminals.harness_overlay(&harness.terminal_id) {
                *harness = next;
            }
        }
    }
    reconcile(state);
}
