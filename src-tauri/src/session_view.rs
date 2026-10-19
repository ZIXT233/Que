//! A session as another agent reads it: final replies, not transcripts, so a
//! coordinating agent spends a few hundred tokens per card.
use crate::models::QueueCard;
use serde_json::{json, Value};

/// Keeps the opening and, mostly, the ending: final replies put conclusions last.
pub fn excerpt(text: &str, limit: usize) -> String {
    let text = text.trim();
    let count = text.chars().count();
    if count <= limit { return text.to_string(); }
    let head = limit * 2 / 5;
    let tail = limit - head;
    let start: String = text.chars().take(head).collect();
    let end: String = text.chars().skip(count - tail).collect();
    format!("{start}\n…（省略 {} 字）…\n{end}", count - head - tail)
}

/// The agent's visible answer for one turn: message text, without thoughts or tools.
fn reply_text(turn: &Value) -> String {
    turn["blocks"].as_array().map(|blocks| blocks.iter()
        .filter(|b| b["type"] == "text_delta" && b["stream"] != "thought")
        .filter_map(|b| b["text"].as_str()).collect::<String>()).unwrap_or_default()
}

fn who(turn: &Value) -> &str {
    if let Some(name) = turn["sender"]["name"].as_str() { return name; }
    match turn["source"].as_str() { Some("event") => "Que", _ => "user" }
}

fn turn_view(turn: &Value, reply_limit: usize) -> Value {
    let tools = turn["blocks"].as_array().map_or(0, |b| b.iter().filter(|b| b["type"] == "tool_call").count());
    let pending = turn["blocks"].as_array().is_some_and(|b| b.iter().any(|b| b["type"] == "decision" && b["state"] == "pending"));
    json!({"turnId":turn["id"],"state":turn["state"],"from":who(turn),"at":turn["at"],"endedAt":turn["endedAt"],
        "message":excerpt(turn["text"].as_str().unwrap_or(""), 400),
        "reply":excerpt(&reply_text(turn), reply_limit),
        "toolCalls":tools,"waitingForUser":pending,
        "error":turn["result"]["error"]["message"]})
}

/// What a coordinating agent needs to know about a session, in a few hundred tokens.
/// `turnId` returns that one turn in full; `detail: "full"` returns everything.
pub fn session_view(card_id: &str, snapshot: &Value, body: &Value) -> Value {
    if body["detail"] == "full" && body["turnId"].is_null() { return snapshot.clone(); }
    let turns: Vec<&Value> = snapshot["turns"].as_array().map(|t| t.iter().filter(|t| t["withdrawn"] != true).collect()).unwrap_or_default();
    if let Some(id) = body["turnId"].as_str() {
        return turns.iter().find(|t| t["id"] == id).map(|t| json!({"cardId":card_id,"turn":t}))
            .unwrap_or_else(|| json!({"cardId":card_id,"error":"Turn not found"}));
    }
    let limit = body["limit"].as_u64().unwrap_or(5).clamp(1, 30) as usize;
    let shown = &turns[turns.len().saturating_sub(limit)..];
    let views: Vec<Value> = shown.iter().enumerate()
        .map(|(i, t)| turn_view(t, if i + 1 == shown.len() { 2000 } else { 400 })).collect();
    let decisions: Vec<Value> = turns.iter().flat_map(|t| t["blocks"].as_array().into_iter().flatten()
        .filter(|b| b["type"] == "decision" && b["state"] == "pending")
        .map(move |b| json!({"turnId":t["id"],"decisionId":b["id"],"kind":b["kind"]}))).collect();
    json!({"cardId":card_id,"state":snapshot["state"],"title":snapshot["title"],"error":snapshot["error"],
        "turns":views,"earlierTurns":turns.len()-shown.len(),"pendingDecisions":decisions,
        "note":"Replies are excerpts. Pass turnId for one complete turn (tool calls, diffs). Pending decisions belong to the user."})
}

/// How a card is named to other agents: the user's nickname, else
/// the session title, else the Agent's name.
pub fn card_name(card: &QueueCard, snapshot: &Value) -> String {
    card.nickname.clone().or_else(|| snapshot["title"].as_str().filter(|t| !t.trim().is_empty()).map(str::to_string))
        .or_else(|| card.harness.as_ref().map(|h| h.kind.clone())).unwrap_or_else(|| card.id.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn excerpts_keep_both_ends_and_count_what_was_dropped() {
        assert_eq!(excerpt("  short  ", 10), "short");
        let long: String = (0..100).map(|i| char::from(b'a' + (i % 26) as u8)).collect();
        let cut = excerpt(&long, 20);
        assert!(cut.starts_with(&long[..8]) && cut.ends_with(&long[88..]));
        assert!(cut.contains("省略 80 字"));
    }
    #[test]
    fn session_view_is_small_and_points_to_detail() {
        let big = "x".repeat(50_000);
        let turns: Vec<Value> = (0..12).map(|i| json!({"id":format!("t{i}"),"state":"completed","text":"do it","at":i,
            "blocks":[{"type":"tool_call","rawOutput":big},{"type":"text_delta","stream":"thought","text":big},{"type":"text_delta","stream":"message","text":format!("answer {i}")}]})).collect();
        let snapshot = json!({"state":"attention","title":"T","turns":turns});
        let view = session_view("c", &snapshot, &json!({}));
        assert!(view.to_string().len() < 3000, "compact view stays small");
        assert_eq!(view["turns"].as_array().unwrap().len(), 5);
        assert_eq!(view["earlierTurns"], 7);
        assert_eq!(view["turns"][4]["reply"], "answer 11");
        assert_eq!(view["turns"][4]["toolCalls"], 1);
        assert_eq!(session_view("c", &snapshot, &json!({"turnId":"t3"}))["turn"]["id"], "t3");
        assert_eq!(session_view("c", &snapshot, &json!({"detail":"full"})), snapshot);
    }
}
