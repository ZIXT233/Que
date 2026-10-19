//! Channels: which cards may talk to each other.
//!
//! A channel joins two cards in both directions: either may message the other
//! and read its session. A card the user gave "all channels" is joined to every
//! card. Channels are made by the user, either directly on a card or by allowing
//! an Agent's request — a message to a card it has no channel with waits in the
//! inbox until then. Only the main window changes channels and permissions: an
//! Agent must not grant itself either.
use crate::{api::AppState, error::{AppError, AppResult}, models::{CardPermissions, CardQueue}};
use serde_json::{json, Value};

fn pair(a: &str, b: &str) -> [String; 2] {
    if a <= b { [a.into(), b.into()] } else { [b.into(), a.into()] }
}

pub fn open(queue: &CardQueue, a: &str, b: &str) -> bool {
    let everyone = |id: &str| queue.cards.iter().any(|c| c.id == id && c.permissions.all_channels);
    a != b && (everyone(a) || everyone(b) || queue.channels.contains(&pair(a, b)))
}

/// Sets what a card's Agent may do beyond its own session.
pub async fn set_permissions(state: &AppState, id: &str, permissions: CardPermissions) -> AppResult<()> {
    state.queue.with_queue(false, |queue| {
        let card = queue.cards.iter_mut().find(|c| c.id == id).ok_or_else(|| AppError::msg("Card not found"))?;
        card.permissions = permissions;
        Ok(())
    }).await?;
    // Joined to everyone now: what waited for a channel from or to it goes.
    if permissions.all_channels { crate::inbox::release_all(id).await?; state.live.notify("channels"); }
    Ok(())
}

/// Joins or separates two cards.
pub async fn set(state: &AppState, a: &str, b: &str, joined: bool) -> AppResult<()> {
    if a == b { return Err(AppError::msg("A card cannot have a channel with itself")); }
    state.queue.with_queue(false, |queue| {
        for id in [a, b] {
            if !queue.cards.iter().any(|c| c.id == id) { return Err(AppError::msg("Card not found")); }
        }
        let link = pair(a, b);
        queue.channels.retain(|c| c != &link);
        if joined { queue.channels.push(link); }
        // A channel lives as long as both cards exist.
        let ids: std::collections::HashSet<String> = queue.cards.iter().map(|c| c.id.clone()).collect();
        queue.channels.retain(|[x, y]| ids.contains(x) && ids.contains(y));
        Ok(())
    }).await?;
    if joined { crate::inbox::release(a, b).await?; }
    // What waited for this channel is answered: the request dialog reads again.
    state.live.notify("channels");
    Ok(())
}

/// Requests waiting for the user, one per pair of cards.
pub async fn requests(state: &AppState) -> AppResult<Value> {
    let queue = state.queue.read_snapshot()?;
    let name = |id: &str| queue.cards.iter().find(|c| c.id == id)
        .map(|c| crate::session_view::card_name(c, &state.harness.debug_snapshot(&c.id, &state.terminals)))
        .unwrap_or_else(|| id.to_string());
    let mut out: Vec<Value> = Vec::new();
    for letter in crate::inbox::held().await? {
        let from = letter.from["cardId"].as_str().unwrap_or_default().to_string();
        if let Some(entry) = out.iter_mut().find(|r| r["from"]["cardId"] == from.as_str() && r["to"]["cardId"] == letter.to.as_str()) {
            entry["count"] = json!(entry["count"].as_u64().unwrap_or(1) + 1);
            continue;
        }
        out.push(json!({"from":{"cardId":from,"name":name(&from)},"to":{"cardId":letter.to,"name":name(&letter.to)},
            "preview":crate::session_view::excerpt(&letter.text, 200),"count":1}));
    }
    Ok(json!(out))
}

/// Allowing opens the channel and sends what waited; refusing drops it and tells the sender.
pub async fn decide(state: &AppState, from: &str, to: &str, allow: bool) -> AppResult<()> {
    if allow { return set(state, from, to, true).await; }
    let dropped = crate::inbox::drop_held(from, to).await?;
    if dropped > 0 {
        let queue = state.queue.read_snapshot()?;
        let target = queue.cards.iter().find(|c| c.id == to)
            .map(|c| crate::session_view::card_name(c, &state.harness.debug_snapshot(&c.id, &state.terminals))).unwrap_or_default();
        crate::inbox::post(crate::inbox::Letter { id: uuid::Uuid::new_v4().to_string(), to: from.into(), held: false,
            from: json!({"cardId":"","name":"QueACP"}), at: crate::queue::now_ms(),
            text: format!("The user did not open a channel to card {to} \"{target}\"; your message was not delivered. Do not send it again unless the user asks.") }).await?;
    }
    state.live.notify("channels");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_channel_works_both_ways_and_all_channels_reaches_everyone() {
        let mut queue = CardQueue::empty();
        queue.cards = serde_json::from_value(json!([
            {"id":"a","cwd":"/w","phase":"attention","createdAt":0},
            {"id":"b","cwd":"/w","phase":"attention","createdAt":0},
            {"id":"c","cwd":"/w","phase":"attention","createdAt":0}
        ])).unwrap();
        queue.channels.push(pair("b", "a"));
        assert!(open(&queue, "a", "b") && open(&queue, "b", "a"));
        assert!(!open(&queue, "a", "c") && !open(&queue, "a", "a"));
        queue.cards[2].permissions.all_channels = true;
        assert!(open(&queue, "a", "c") && open(&queue, "c", "b") && !open(&queue, "c", "c"));
    }
}
