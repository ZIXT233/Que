mod common;
mod handlers;
mod mcp;
use std::env;
fn run() -> Result<(), Box<dyn std::error::Error>> {
    let exe = env::current_exe()?;
    let dir = exe.parent().ok_or("missing executable directory")?;
    let stem = exe.file_stem().and_then(|s| s.to_str()).unwrap_or("");
    let args: Vec<String> = env::args().skip(1).collect();
    let (kind, event, ambient) = match stem {
        "que-session-state" => ("grok", None, false),
        "que-cursor-hook" => ("cursor", args.first().map(String::as_str), false),
        "external-hook" => ("claude", None, true),
        "devin-hook" => ("devin", None, true),
        _ => (
            args.first()
                .map(String::as_str)
                .ok_or("usage: que-hook <harness|codex-mcp> [event]")?,
            args.get(1).map(String::as_str),
            false,
        ),
    };
    if kind == "codex-mcp" {
        return mcp::serve(dir);
    }
    handlers::validate(kind)?;
    if handlers::skip(kind, ambient) {
        return Ok(());
    }
    let payload = common::read_payload(std::io::stdin().lock())?;
    common::deliver(dir, kind, event, &payload)?;
    use std::io::Write;
    if matches!(kind, "cursor" | "grok" | "gemini") {
        writeln!(
            std::io::stdout().lock(),
            "{}",
            handlers::reply(
                kind,
                event.or_else(|| payload.get("hook_event_name").and_then(|v| v.as_str()))
            )
        )?;
    }
    Ok(())
}
fn main() {
    if let Err(error) = run() {
        eprintln!("Que hook: {error}");
        std::process::exit(1);
    }
}
