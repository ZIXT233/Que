# Que native hook runtime

A standalone Rust executable, with no Tauri, Node, or PowerShell dependency.
Windows registrations use it today; macOS/Linux and SSH retain their existing ingress.
Pi, OMP, and OpenCode remain in-process plugins.

## Layout

- src/common.rs: bounded incremental JSON input, normalization, internal/external sink routing, atomic files and stale-file cleanup.
- src/handlers/: provider event contracts, compatibility guards and verdicts.
- src/mcp.rs: persistent newline-framed JSON-RPC MCP server for Codex.
- src/main.rs: command entrypoints and dispatch.

Command mode: que-hook.exe <harness> [event], JSON on stdin.
MCP mode: que-hook.exe codex-mcp, one process for the session.
Grok uses the identical binary named que-session-state.exe beside its hook JSON so its runner directly executes a bare filename. Cursor's que-cursor-hook.exe accepts the event as its first argument. Claude's external-hook.exe skips ambient hooks for Que cards and foreign compatibility readers. These names are entrypoint aliases, not separate implementations.

QUE_HARNESS_SIGNAL_DIR selects a card sink. Otherwise QUE_EXTERNAL_SIGNAL_DIR or the adjacent .sink file selects the active profile's external sink. A channel-only invocation fails explicitly rather than leaking remote events into the local notification queue. No network listener is opened.

Complete JSON is processed immediately even if stdin stays open. Input is limited to 1 MiB. Unknown providers/events and write failures return nonzero; MCP reports tool errors without terminating the persistent process. stdout contains only the provider verdict or JSON-RPC. Diagnostics go to stderr, and optional MCP timing logs contain event names and PID rather than prompt content.

## Build and distribution

The Tauri build script builds this independent crate with --locked --release for the same target in a separate OUT_DIR target directory, then embeds its executable. Runtime installers extract that binary alongside owned hook configuration. No Node installation is needed by these Windows hook receivers. Updating a locked executable returns an installation error and leaves the existing configuration intact.

This does not remove a shell chosen by the upstream CLI. In particular Cursor still invokes PowerShell; measure its full hook executor time separately from native handler time.

## Verification

Use scripts/harness-e2e/native-runtime.cjs with the executable for real process protocol checks, including deliberately open stdin and Unicode/spaced paths. codex-mcp-contract.cjs accepts the native executable as its first argument. cursor-executor.cjs exercises the installed Cursor executor with real PowerShell; it is not a whole CLI turn benchmark. grok-native.mjs exercises installed Grok plus the production Que queue through a headless backend.
