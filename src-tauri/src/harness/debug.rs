use super::signals::ProbeState;
use crate::paths::signal_dir;
use crate::terminal::{PtyProbe, TerminalHub};
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;

const MAX_EVENTS: usize = 80;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessDebugEvent {
    pub at: i64,
    pub source: String,
    pub event: String,
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

pub type DebugLog = Mutex<HashMap<String, Vec<HarnessDebugEvent>>>;

pub fn record(log: &DebugLog, terminal_id: &str, event: HarnessDebugEvent) {
    let mut map = log.lock();
    let events = map.entry(terminal_id.to_string()).or_default();
    events.push(event);
    if events.len() > MAX_EVENTS {
        let extra = events.len() - MAX_EVENTS;
        events.drain(..extra);
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessDebugSnapshot {
    pub terminal_id: String,
    pub signal_dir: String,
    pub probe: Option<ProbeView>,
    pub events: Vec<HarnessDebugEvent>,
    pub trace: Vec<Value>,
    pub last_stop_diagnostic: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pty: Option<PtyProbe>,
    pub clues: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeView {
    pub state: String,
    pub source: Option<String>,
    pub hook_seen: bool,
    pub title_seen: bool,
    pub session_id: Option<String>,
    pub session_name: Option<String>,
    pub first_prompt: Option<String>,
    pub submit_prompt: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub notify_osc_seen: Vec<String>,
    #[serde(skip_serializing_if = "is_zero")]
    pub notify_osc_hits: u32,
}

fn is_zero(value: &u32) -> bool {
    *value == 0
}

impl ProbeView {
    pub fn from_state(state: &ProbeState) -> Self {
        Self {
            state: state.state.clone(),
            source: state.source.clone(),
            hook_seen: state.hook_seen,
            title_seen: state.title_seen,
            session_id: state.session_id.clone(),
            session_name: state.session_name.clone(),
            first_prompt: state.first_prompt.clone(),
            submit_prompt: state.submit_prompt.clone(),
            notify_osc_seen: state.notify_osc_seen.clone(),
            notify_osc_hits: state.notify_osc_hits,
        }
    }
}

pub fn snapshot(
    log: &DebugLog,
    probes: &Mutex<HashMap<String, ProbeState>>,
    terminals: &TerminalHub,
    terminal_id: &str,
) -> HarnessDebugSnapshot {
    let directory = signal_dir(terminal_id);
    let events = log.lock().get(terminal_id).cloned().unwrap_or_default();
    let state = probes.lock().get(terminal_id).cloned();
    let probe = state.as_ref().map(ProbeView::from_state);
    let pty = terminals.probe(terminal_id);
    let clues = clues(
        state.as_ref().and_then(|s| s.kind.as_deref()),
        probe.as_ref(),
        pty.as_ref(),
        &events,
    );
    let trace = std::fs::read_to_string(directory.join("hook-trace.jsonl"))
        .ok()
        .map(|raw| {
            raw.lines()
                .rev()
                .take(80)
                .filter_map(|line| serde_json::from_str(line).ok())
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect()
        })
        .unwrap_or_default();
    let last_stop_diagnostic = std::fs::read_to_string(directory.join("last-stop-diagnostic.json"))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok());
    HarnessDebugSnapshot {
        terminal_id: terminal_id.into(),
        signal_dir: directory.to_string_lossy().into_owned(),
        probe,
        events,
        trace,
        last_stop_diagnostic,
        pty,
        clues,
    }
}

fn clues(
    kind: Option<&str>,
    probe: Option<&ProbeView>,
    pty: Option<&PtyProbe>,
    events: &[HarnessDebugEvent],
) -> Vec<String> {
    let mut clues = Vec::new();
    let Some(pty) = pty else {
        clues.push("PTY 记录不存在：卡片引用的终端已不在内存里".into());
        return clues;
    };
    if !pty.reader_alive {
        clues.push("读线程已停：后面的画面不会再更新".into());
    }
    if pty.bytes_in == 0 {
        clues.push("PTY 一个字节都没读到：子进程没往终端写，或 reader 没挂上".into());
    }
    if pty.bytes_in > 0 && pty.events_emitted == 0 {
        clues.push("读到了字节但没发出事件：UTF-8 拆包一直 hold，或事件没 emit".into());
    }
    if pty.listeners == 0 && pty.bytes_in > 0 {
        clues.push(
            "有输出但 SSE 听众是 0：前端没连上 /api/terminal/:id/events，或连上后又断了".into(),
        );
    }
    if pty.send_fail > 0 {
        clues.push(format!(
            "有 {} 次听众发送失败：SSE 消费者掉了",
            pty.send_fail
        ));
    }
    if pty.on_output_panic > 0 {
        if pty.reader_alive {
            clues.push("on_output 崩过：该块 hook/OSC 探针没跑完；读线程还在，画面还会更新".into());
        } else {
            clues.push("on_output 崩过，且读线程已停".into());
        }
    }
    if pty.last_write_ms >= 200 {
        clues.push(format!(
            "最近一次写入 PTY 堵了 {}ms：子进程没在读 stdin（常见于 Cursor hook 死锁）",
            pty.last_write_ms
        ));
    }
    if pty.write_err > 0 {
        clues.push("PTY write 失败过".into());
    }
    if pty.resize_count == 0 {
        clues.push("从未收到前端 resize：xterm 和 PTY 尺寸可能一直对不齐".into());
    }
    if let (Some(ic), Some(ir)) = (pty.ioctl_cols, pty.ioctl_rows) {
        if pty.resize_count > 0 && (ic != pty.last_resize_cols || ir != pty.last_resize_rows) {
            clues.push(format!(
                "ioctl 是 {ic}x{ir}，前端上次要的是 {}x{}：WINCH 没落到 PTY",
                pty.last_resize_cols, pty.last_resize_rows
            ));
        }
        if ic == 100 && ir == 30 && pty.resize_count == 0 {
            clues.push("PTY 还停在启动默认 100x30，前端 fit 尺寸没写进去".into());
        }
    }
    if let Some(error) = &pty.last_error {
        clues.push(format!("lastError: {error}"));
    }
    if let Some(probe) = probe {
        if probe.hook_seen
            && events
                .iter()
                .any(|e| e.event == "beforeSubmitPrompt" || e.event == "UserPromptSubmit")
            && !events.iter().any(|e| {
                matches!(
                    e.event.as_str(),
                    "stop" | "Stop" | "afterAgentResponse" | "sessionEnd"
                )
            })
        {
            clues.push("hooks 看到了提交，但没有 stop/afterAgentResponse：CLI 在提交后卡住，不是卡片状态机".into());
        }
    }
    // A harness whose notification channel needs its own heuristics adds them here.
    if let Some(harness) = kind.and_then(super::registry::find) {
        harness.debug_clues(probe, Some(pty), events, &mut clues);
    }
    if clues.is_empty() {
        clues.push(
            "后端在送数据。若画面仍缺，看 debug 里的 xterm 字段：sse 计数是否远小于 eventsEmitted"
                .into(),
        );
    }
    clues
}
