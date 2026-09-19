# Windows unified Rust hook runtime — 2026-09-20

## Implemented

Independent Cargo crate: src-tauri/hook-runtime. Shared bounded JSON reader, signal normalization, atomic file delivery, provider modules, Codex persistent MCP. One release binary embedded by build.rs and extracted by Windows installers. Grok/Cursor/Claude ambient aliases contain identical executable bytes. No Node process inside these native receivers.

Windows registrations now select native ingress for Claude, Cursor, Grok, CodeBuddy, Antigravity, Gemini and Codex. Codex keeps MCP; Pi/OMP/OpenCode keep their in-process plugins. macOS/Linux/SSH retain existing implementations. There was no GUI verification.

## Evidence

- Main library build passed using C:/Users/ZIXT/Que-headless-target, independent of the dev app target. Adapter tests: 44 passed.
- Native process protocol matrix: six command providers, both sinks, Unicode/spaced/apostrophe paths, stdin intentionally left open, Cursor permission verdicts and unknown-event rejection. Evidence temp directory: que native 中文's WN2tNm.
- MCP contract: all six events, internal/external scopes, two turns, Unicode text and previews. Latest temp directory: que-mcp-contract-vNEwJk.
- Installed Codex 0.155.0 interactive TUI, internal two turns: que-codex-mcp-yDkBHd/report.json. SessionStart=1; Submit/PreToolUse/PostToolUse/Stop=2 each. One native MCP PID=14536. External interactive turn: que-codex-mcp-ZEX0Em/report.json, all five events exactly once. No signal leakage. Tests overrode this invocation's MCP receiver, used the existing account and a read-only Write-Output command, and exited both CLIs. MCP delivery timings are receiver timings, not whole-hook latency.
- Installed Grok + production headless Que queue: que grok native 中文-5IjmU6/report.json, que-e2e-lSIMXb/case-0/report.json. External notice, internal two turns and compatibility readers enabled all passed. Grok-reported process-inclusive native hook elapsed_ms: 76,54,29,31. Whole external CLI took 14.2 seconds, including an unrelated acp_initialize delay; this is not all hook time.
- Installed Claude full local-model external turn: que compat 中文-QKK2gQ/claude-false-false.json. All three lifecycle events once. Entire CLI test 8.6 seconds; not a hook latency claim.
- Installed CodeBuddy full local-model external turn: que-codebuddy-cli-Uxp78E/report.json. All three events once.
- Installed Cursor executor + real PowerShell: que cursor 中文's executor-CkIX43/report.json. Native beforeSubmitPrompt and foreign Claude suppression passed both payload transports. Cursor test calls took 7154ms and 3514ms. PowerShell emitted first-use module preparation messages. This test supplies a shell transport to the actual executor; it is neither a full Cursor turn nor proof of production shell-driver latency. Native conversion does NOT solve this remaining shell overhead.

Antigravity and Gemini have native protocol coverage but no full installed-CLI turn in this change. No claim that all Windows hook latency is solved.

## Reproduction

Build the independent crate with cargo build --manifest-path src-tauri/hook-runtime/Cargo.toml --locked --release --target-dir <separate-target>.
Pass the resulting que-hook.exe to native-runtime.cjs, launcher.cjs, codex-mcp-contract.cjs and cursor-executor.cjs. codebuddy-cli.cjs accepts it as the second argument after the installed JS entrypoint. compat-cli.cjs supports --only-claude. codex-mcp-tui.cjs accepts --native EXE plus --turns 2 or --external; this test makes real model requests and requires interactive terminal input.
