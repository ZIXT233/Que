//! Each card's inbox of messages from other cards. A message is handed over
//! exactly once, by whichever comes first:
//! - the card is idle: it becomes the card's next turn, sender named in its header;
//! - the card is busy: it rides on the card's next QueACP tool result, or on its
//!   `wait_messages` call — the closest ACP gets to reading mail between tool calls;
//! - otherwise it becomes a turn once the current one ends.
use crate::{api::AppState, error::{AppError, AppResult}};
use serde_json::{json, Value};
use std::time::Duration;
use tokio::sync::{Mutex, Notify};

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Letter {
    pub id: String,
    pub to: String,
    /// `{cardId, name}` of the sending card.
    pub from: Value,
    pub text: String,
    pub at: i64,
}

pub const WAIT_DEFAULT_SECS: u64 = 50;
pub const WAIT_MAX_SECS: u64 = 120;
/// Bound on undelivered messages per card; the oldest go first.
const INBOX_CAP: usize = 50;

static INBOX: Mutex<Option<Vec<Letter>>> = Mutex::const_new(None);
static ARRIVED: Notify = Notify::const_new();
/// One delivery at a time, so a letter is never handed over twice.
static DELIVERY: Mutex<()> = Mutex::const_new(());
static RETRY: std::sync::LazyLock<Mutex<std::collections::HashMap<String, std::time::Instant>>> = std::sync::LazyLock::new(Default::default);

fn file() -> std::path::PathBuf { crate::paths::data_dir().join("mcp").join("inbox.json") }

async fn with_inbox<T>(change: impl FnOnce(&mut Vec<Letter>) -> T) -> AppResult<T> {
    let mut guard = INBOX.lock().await;
    let letters = guard.get_or_insert_with(|| {
        std::fs::read(file()).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default()
    });
    let before = serde_json::to_string(letters)?;
    let value = change(letters);
    let after = serde_json::to_string(letters)?;
    if after != before {
        std::fs::create_dir_all(crate::paths::data_dir().join("mcp"))?;
        crate::paths::atomic_write(&file(), &after)?;
    }
    Ok(value)
}

pub async fn post(letter: Letter) -> AppResult<()> {
    with_inbox(|letters| {
        if letters.iter().any(|l| l.id == letter.id) { return; }
        let to = letter.to.clone();
        letters.push(letter);
        while letters.iter().filter(|l| l.to == to).count() > INBOX_CAP {
            let oldest = letters.iter().position(|l| l.to == to).unwrap();
            letters.remove(oldest);
        }
    }).await?;
    ARRIVED.notify_waiters();
    Ok(())
}

/// Hands over everything waiting for `card`, oldest first.
pub async fn take(card: &str) -> AppResult<Vec<Letter>> {
    let _delivery = DELIVERY.lock().await;
    with_inbox(|letters| {
        let (mine, rest) = std::mem::take(letters).into_iter().partition(|l| l.to == card);
        *letters = rest;
        mine
    }).await
}

/// How a handed-over message reads in a tool result.
pub fn shown(letters: &[Letter]) -> Value {
    json!(letters.iter().map(|l| json!({"from":l.from,"text":l.text,"at":l.at,
        "note":"From another agent, not the user. To answer, send_message to this cardId."})).collect::<Vec<_>>())
}

/// Blocks until a message for `card` arrives or the wait ends.
pub async fn wait(card: &str, seconds: u64) -> AppResult<Vec<Letter>> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(seconds.clamp(1, WAIT_MAX_SECS));
    loop {
        let arrived = ARRIVED.notified();
        let letters = take(card).await?;
        if !letters.is_empty() { return Ok(letters); }
        if tokio::time::timeout_at(deadline, arrived).await.is_err() { return Ok(Vec::new()); }
    }
}

fn busy(snapshot: &Value) -> bool {
    snapshot["state"] == "starting" || snapshot["turns"].as_array().is_some_and(|turns| turns.iter()
        .any(|t| t["withdrawn"] != true && matches!(t["state"].as_str(), Some("running" | "queued" | "cancelling"))))
}

/// Starts a turn with the oldest message of each idle recipient.
async fn deliver(state: &AppState) {
    let recipients: Vec<String> = match with_inbox(|letters| letters.iter().map(|l| l.to.clone()).collect::<Vec<_>>()).await {
        Ok(mut ids) => { ids.sort(); ids.dedup(); ids }
        Err(_) => return,
    };
    for card_id in recipients {
        // A card that cannot be reached is retried quietly every half minute.
        if RETRY.lock().await.get(&card_id).is_some_and(|at| at.elapsed() < Duration::from_secs(30)) { continue; }
        if let Err(error) = deliver_one(state, &card_id).await {
            crate::debuglog::warn("inbox", &format!("card={card_id} delivery waits: {error}"));
            RETRY.lock().await.insert(card_id, std::time::Instant::now());
        } else {
            RETRY.lock().await.remove(&card_id);
        }
    }
}

async fn deliver_one(state: &AppState, card_id: &str) -> AppResult<()> {
    let queue = state.queue.read_snapshot()?;
    let Some(card) = queue.cards.iter().find(|c| c.id == card_id && c.archived_at.is_none()) else {
        // Nobody will read these: the card is gone or archived.
        take(card_id).await?;
        return Ok(());
    };
    let session = card.harness.as_ref().map(|h| h.terminal_id.clone()).ok_or_else(|| AppError::msg("card has no Agent"))?;
    if !state.harness.is_live(&session) { crate::acp_supervisor::ensure_card(state, card_id, &session).await?; }
    let _delivery = DELIVERY.lock().await;
    if busy(&state.harness.debug_snapshot(card_id, &state.terminals)) { return Ok(()); }
    let Some(letter) = with_inbox(|letters| letters.iter().find(|l| l.to == card_id).cloned()).await? else { return Ok(()) };
    let ws = crate::api::acp_workspace(state, card_id).await?;
    // The letter id is the request id: a repeated delivery is the same turn.
    state.harness.request(&ws, &state.bin_dir, json!({"action":"send","id":card_id,"requestId":format!("letter:{}",letter.id),
        "text":letter.text,"env":ws.session_env,"hostAccess":card.harness.as_ref().and_then(|h|h.host_access),"sender":letter.from})).await?;
    with_inbox(|letters| letters.retain(|l| l.id != letter.id)).await?;
    Ok(())
}

pub fn start(state: AppState) {
    tokio::spawn(async move {
        let mut events = state.live.subscribe();
        loop {
            deliver(&state).await;
            tokio::select! {
                _ = events.recv() => {},
                _ = ARRIVED.notified() => {},
                _ = tokio::time::sleep(Duration::from_secs(1)) => {},
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_card_is_busy_while_a_turn_runs_or_waits() {
        assert!(!busy(&json!({"state":"attention","turns":[{"state":"completed"}]})));
        assert!(busy(&json!({"state":"working","turns":[{"state":"running"}]})));
        assert!(busy(&json!({"state":"attention","turns":[{"state":"queued"}]})));
        assert!(!busy(&json!({"state":"attention","turns":[{"state":"queued","withdrawn":true}]})));
        assert!(busy(&json!({"state":"starting"})));
        assert!(!busy(&Value::Null), "an unconnected card is idle: delivery connects it");
    }
}
