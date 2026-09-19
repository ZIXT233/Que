use crate::handlers::codex;
use serde_json::{json, Value};
use std::{
    io::{BufRead, Write},
    path::Path,
};
pub fn serve(dir: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let mut input = std::io::stdin().lock();
    let mut output = std::io::stdout().lock();
    loop {
        // Bounded framing, including when a peer never supplies a newline.
        let mut line = Vec::new();
        loop {
            let chunk = input.fill_buf()?;
            if chunk.is_empty() {
                if line.is_empty() {
                    return Ok(());
                } else {
                    return Err("truncated MCP frame".into());
                }
            }
            let n = chunk
                .iter()
                .position(|b| *b == b'\n')
                .map(|n| n + 1)
                .unwrap_or(chunk.len());
            if line.len() + n > crate::common::MAX_INPUT {
                return Err("MCP frame exceeds 1 MiB".into());
            }
            line.extend_from_slice(&chunk[..n]);
            input.consume(n);
            if line.last() == Some(&b'\n') {
                break;
            }
        }
        let Ok(request) = serde_json::from_slice::<Value>(&line) else {
            continue;
        };
        let Some(id) = request.get("id") else {
            continue;
        };
        let result = match request["method"].as_str().unwrap_or("") {
            "initialize" => {
                json!({"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"que-session-state","version":"1.0.0"}})
            }
            "ping" => json!({}),
            "tools/list" => {
                json!({"tools":[{"name":"session_state","description":"Receive lifecycle events from configured hooks. Do not call manually.","inputSchema":{"type":"object","properties":{"hook_event_name":{"type":"string","enum":codex::EVENTS},"session_id":{"type":"string"}},"required":["hook_event_name","session_id"],"additionalProperties":true}}]})
            }
            "tools/call" if request["params"]["name"] == "session_state" => {
                let started = std::time::Instant::now();
                let payload = &request["params"]["arguments"];
                let event = payload["hook_event_name"].as_str().unwrap_or("");
                let error = if !codex::EVENTS.contains(&event) || !payload["session_id"].is_string()
                {
                    Some("Invalid lifecycle event".to_owned())
                } else if codex::skip_scope(payload) {
                    None
                } else {
                    crate::common::deliver(dir, "codex", None, payload)
                        .err()
                        .map(|e| e.to_string())
                };
                if std::env::var("QUE_HOOK_DEBUG").as_deref() == Ok("1") {
                    if let Some(path) = std::env::var_os("QUE_HOOK_DEBUG_FILE") {
                        if let Ok(mut file) = std::fs::OpenOptions::new()
                            .create(true)
                            .append(true)
                            .open(path)
                        {
                            let _ = writeln!(
                                file,
                                "{}",
                                json!({"pid":std::process::id(),"stage":"mcp-delivered","event":event,"elapsedMs":started.elapsed().as_secs_f64()*1000.0,"ok":error.is_none()})
                            );
                        }
                    }
                }
                match error {
                    Some(error) => json!({"isError":true,"content":[{"type":"text","text":error}]}),
                    None => json!({"content":[{"type":"text","text":"{}"}]}),
                }
            }
            _ => {
                writeln!(
                    output,
                    "{}",
                    json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"Method not found"}})
                )?;
                output.flush()?;
                continue;
            }
        };
        writeln!(
            output,
            "{}",
            json!({"jsonrpc":"2.0","id":id,"result":result})
        )?;
        output.flush()?;
    }
}
