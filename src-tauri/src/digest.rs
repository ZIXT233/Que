//! Scheduled Butler digest. Nothing wakes the Butler as cards work; on schedule
//! it gets one compact status table and writes the user a summary. Its reply
//! puts the Butler card in the queue like any other card.
use crate::{api::AppState, error::{AppError, AppResult}, session_view::{card_name, excerpt, reply_text}, models::CardPhase};
use chrono::{Datelike, Local, Timelike};
use serde_json::{json, Value};
use std::time::Duration;

/// The schedule is chosen from presets in settings; all of them reduce to cron.
pub fn schedule_cron(pref: &Value) -> Option<String> {
    let time = pref["time"].as_str().and_then(|t| t.split_once(':'))
        .and_then(|(h, m)| Some((h.parse::<u32>().ok().filter(|h| *h < 24)?, m.parse::<u32>().ok().filter(|m| *m < 60)?)));
    match pref["mode"].as_str()? {
        "daily" => time.map(|(h, m)| format!("{m} {h} * * *")),
        "weekdays" => time.map(|(h, m)| format!("{m} {h} * * 1-5")),
        "interval" => pref["intervalHours"].as_u64().filter(|n| (1..=12).contains(n)).map(|n| format!("0 */{n} * * *")),
        "custom" => pref["cron"].as_str().map(str::trim).filter(|c| cron_valid(c)).map(str::to_string),
        _ => None,
    }
}

fn field(spec: &str, value: u32, min: u32, max: u32) -> Option<bool> {
    let mut hit = false;
    for part in spec.split(',') {
        let (range, step) = match part.split_once('/') { Some((r, s)) => (r, s.parse::<u32>().ok().filter(|s| *s > 0)?), None => (part, 1) };
        let (lo, hi) = if range == "*" { (min, max) }
            else if let Some((a, b)) = range.split_once('-') { (a.parse().ok()?, b.parse().ok()?) }
            else { let v: u32 = range.parse().ok()?; (v, if part.contains('/') { max } else { v }) };
        if lo < min || hi > max || lo > hi { return None; }
        hit |= value >= lo && value <= hi && (value - lo) % step == 0;
    }
    Some(hit)
}

/// Standard five-field cron (minute hour day-of-month month day-of-week).
pub fn cron_matches(expr: &str, minute: u32, hour: u32, day: u32, month: u32, weekday: u32) -> Option<bool> {
    let f: Vec<&str> = expr.split_whitespace().collect();
    if f.len() != 5 { return None; }
    let dom = field(f[2], day, 1, 31)?;
    let dow = field(f[4], weekday, 0, 7)? || (weekday == 0 && field(f[4], 7, 0, 7)?);
    // Cron's rule: when both day fields are restricted, either may match.
    let day_ok = if f[2] != "*" && f[4] != "*" { dom || dow } else { dom && dow };
    Some(field(f[0], minute, 0, 59)? && field(f[1], hour, 0, 23)? && field(f[3], month, 1, 12)? && day_ok)
}
pub fn cron_valid(expr: &str) -> bool { cron_matches(expr, 0, 0, 1, 1, 0).is_some() }

fn state_file() -> std::path::PathBuf { crate::paths::data_dir().join("mcp").join("digest.json") }
/// `lastMinute` claims a scheduled slot; `lastSentAt` is when the previous digest went out.
fn load_state() -> Value {
    std::fs::read(state_file()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_else(|| json!({}))
}
fn save_state(patch: Value) -> AppResult<()> {
    let mut value = load_state();
    if let (Some(value), Some(patch)) = (value.as_object_mut(), patch.as_object()) { value.extend(patch.clone()); }
    std::fs::create_dir_all(crate::paths::data_dir().join("mcp"))?;
    Ok(crate::paths::atomic_write(&state_file(), &value.to_string())?)
}

fn ago(ms: i64) -> String {
    let minutes = (crate::queue::now_ms() - ms).max(0) / 60_000;
    match minutes { 0 => "刚刚".into(), m if m < 60 => format!("{m} 分钟前"), m if m < 48 * 60 => format!("{} 小时前", m / 60), m => format!("{} 天前", m / 1440) }
}

fn card_line(state: &AppState, queue: &crate::models::CardQueue, card: &crate::models::QueueCard, since: i64) -> String {
    let snapshot = state.harness.debug_snapshot(&card.id, &state.terminals);
    let turns: Vec<&Value> = snapshot["turns"].as_array().map(|t| t.iter().filter(|t| t["withdrawn"] != true).collect()).unwrap_or_default();
    let name = card_name(card, &snapshot);
    let workspace = queue.workspaces.as_ref().and_then(|w| w.iter().find(|w| Some(&w.id) == card.workspace_id.as_ref())).map(|w| w.name.clone()).unwrap_or_default();
    let decisions = turns.iter().flat_map(|t| t["blocks"].as_array().into_iter().flatten()).filter(|b| b["type"] == "decision" && b["state"] == "pending").count();
    let status = match (&card.phase, snapshot["state"].as_str()) {
        (_, Some("error")) => "出错".to_string(),
        (CardPhase::Working, _) => "Agent 工作中".to_string(),
        _ if decisions > 0 => format!("等你确认 {decisions} 项"),
        _ => format!("等你回复（{}）", card.waiting_since.or(card.ready_at).map(ago).unwrap_or_else(|| "时间未知".into())),
    };
    let last = turns.iter().filter_map(|t| t["endedAt"].as_i64().or(t["at"].as_i64())).max();
    let ask = turns.iter().rev().find(|t| t["source"] != "event" && t["sender"].is_null()).and_then(|t| t["text"].as_str()).map(|t| excerpt(t, 100));
    let reply = turns.iter().rev().find(|t| t["source"] != "event").map(|t| excerpt(&reply_text(t), 240)).filter(|r| !r.is_empty());
    let ended = |state: &str| turns.iter().filter(|t| t["state"] == state && t["source"] != "event" && t["endedAt"].as_i64().is_some_and(|at| at > since)).count();
    let (done, failed) = (ended("completed"), ended("failed"));
    let mut line = format!("- 「{name}」{} · {status} · 最近活动：{}", if workspace.is_empty() { String::new() } else { format!("（{workspace}）") }, last.map(ago).unwrap_or_else(|| "无记录".into()));
    if let Some(ask) = ask { line.push_str(&format!("\n  用户上次说：{ask}")); }
    if let Some(reply) = reply { line.push_str(&format!("\n  最后回复：{reply}")); }
    if done + failed > 0 { line.push_str(&format!("\n  自上次汇总：完成 {done} 轮，失败 {failed} 轮")); }
    line
}

/// Sends the digest request to the Butler now. Returns false when there is no started Butler.
pub async fn run(state: &AppState, request_id: &str) -> AppResult<bool> {
    let queue = state.queue.read_snapshot()?;
    let Some(butler) = queue.cards.iter().find(|c| crate::butler::is_card(c) && c.archived_at.is_none() && c.harness.is_some()) else { return Ok(false) };
    let since = load_state()["lastSentAt"].as_i64().unwrap_or(0);
    let lines: Vec<String> = queue.cards.iter()
        .filter(|c| c.archived_at.is_none() && c.harness.is_some() && !crate::butler::is_card(c))
        .map(|c| card_line(state, &queue, c, since)).collect();
    let body = if lines.is_empty() { "（目前没有其他会话卡片）".to_string() } else { lines.join("\n") };
    let text = format!("Que 定时汇总请求（自动发出，不是用户消息）。请根据下面各会话的现状，用用户的语言给用户写一份简短汇总：\n1. 有进展的事\n2. 等用户处理或卡住的事\n3. 很久（两天以上）没动、可能被遗忘的事\n4. 建议优先处理的最多三件（只是建议，由用户决定）\n不要给其他卡片发消息，不要执行任何操作；可以据此更新 STATE.md。\n\n{body}");
    let ws = crate::api::acp_workspace(state, &butler.id).await?;
    state.harness.request(&ws, &state.bin_dir, json!({"action":"send","id":butler.id,"requestId":request_id,"mode":"notification","text":text})).await?;
    save_state(json!({"lastSentAt":crate::queue::now_ms()}))?;
    Ok(true)
}

async fn tick(state: &AppState) -> AppResult<()> {
    let pref = crate::mcp_settings::read_preferences()?["butlerDigest"].clone();
    let Some(cron) = schedule_cron(&pref) else { return Ok(()) };
    let now = Local::now();
    if cron_matches(&cron, now.minute(), now.hour(), now.day(), now.month(), now.weekday().num_days_from_sunday()) != Some(true) { return Ok(()); }
    let minute = now.timestamp() / 60;
    if load_state()["lastMinute"].as_i64() == Some(minute) { return Ok(()); }
    // Claim the slot first: a digest that fails is skipped, never sent twice.
    save_state(json!({"lastMinute":minute}))?;
    if !run(state, &format!("digest:{minute}")).await? { return Err(AppError::msg("Butler has not been started")); }
    Ok(())
}

pub fn start(state: AppState) {
    tokio::spawn(async move {
        loop {
            if let Err(error) = tick(&state).await { crate::debuglog::warn("digest", &format!("scheduled digest skipped: {error}")); }
            // Every minute is visited at least once, so no scheduled slot is skipped.
            tokio::time::sleep(Duration::from_secs(20)).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn presets_become_cron() {
        assert_eq!(schedule_cron(&json!({"mode":"daily","time":"09:05"})).as_deref(), Some("5 9 * * *"));
        assert_eq!(schedule_cron(&json!({"mode":"weekdays","time":"18:30"})).as_deref(), Some("30 18 * * 1-5"));
        assert_eq!(schedule_cron(&json!({"mode":"interval","intervalHours":4})).as_deref(), Some("0 */4 * * *"));
        assert_eq!(schedule_cron(&json!({"mode":"custom","cron":"0 9,14 * * 1-5"})).as_deref(), Some("0 9,14 * * 1-5"));
        for off in [json!({"mode":"off","time":"09:00"}), json!({"mode":"daily","time":"25:00"}), json!({"mode":"custom","cron":"nope"}), json!({"mode":"interval","intervalHours":0})] {
            assert_eq!(schedule_cron(&off), None);
        }
    }
    #[test]
    fn cron_follows_the_usual_rules() {
        // minute hour day month weekday(0 = Sunday)
        assert_eq!(cron_matches("30 18 * * 1-5", 30, 18, 7, 10, 3), Some(true));
        assert_eq!(cron_matches("30 18 * * 1-5", 30, 18, 11, 10, 6), Some(false));
        assert_eq!(cron_matches("0 */4 * * *", 0, 8, 1, 1, 0), Some(true));
        assert_eq!(cron_matches("0 */4 * * *", 0, 9, 1, 1, 0), Some(false));
        assert_eq!(cron_matches("0 9 * * 7", 0, 9, 5, 10, 0), Some(true), "7 is Sunday too");
        assert_eq!(cron_matches("0 9 1 * 1", 0, 9, 1, 10, 4), Some(true), "restricted day fields match either");
        assert_eq!(cron_matches("0 9 1 * 1", 0, 9, 2, 10, 4), Some(false));
        assert!(!cron_valid("61 * * * *") && !cron_valid("* * *") && !cron_valid("*/0 * * * *"));
    }
}
