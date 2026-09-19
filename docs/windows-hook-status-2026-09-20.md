# Windows harness hook routes — 2026-09-20

This records the Windows production routes, their limits, and the results that
have actually been observed. A native receiver makes Que's own event handling
cheap; it cannot remove time spent by a CLI's hook executor before that receiver
starts.

## Shared native receiver

For Windows, the Tauri build compiles `src-tauri/hook-runtime` for the current
target and embeds the resulting `que-hook.exe` in Que. Installing a harness
extracts identical bytes beside Que-owned configuration, with an entrypoint name
appropriate to that CLI. The executable reads hook JSON from stdin or serves a
persistent Codex MCP connection, normalizes the event, and writes it to the
card's signal directory or the active external signal directory. It does not
start Node, PowerShell, or an HTTP listener.

It is deliberately a Windows-only distribution detail: macOS, Linux, and SSH
keep their shell or plugin ingress. The macOS/Linux bundles do not contain this
executable or ConPTY. See `src-tauri/hook-runtime/README.md` for its process and
input contract.

## Current matrix

| Harness | Windows route | Current result / limitation |
| --- | --- | --- |
| Claude | `external-hook.exe` or card-local `que-hook.exe` command hook | User-confirmed normal hook delay. External capture is supported. |
| Codex | One persistent `que-hook.exe codex-mcp` stdio MCP server per session | Avoids a command process for every lifecycle event. The historical command-hook delay must not be used as a measure of this route. |
| Grok | Bare `que-session-state.exe` beside Que's hook JSON | Direct executable invocation; no shell, Node, or local HTTP transport. External capture is supported. Grok's own Claude/Cursor compatibility toggles remain the user's settings; Que does not turn them off. |
| Antigravity (AGY) | `que-hook.exe` command hook | AGY's Windows runner requires `pushd <Que directory> && que-hook.exe ...` so a path with spaces is not parsed as a leading quoted command. User confirmed this route works. External capture is supported. |
| Cursor | `que-cursor-hook.exe`, invoked by Cursor's PowerShell hook executor | Que's receiver is native, but Cursor still starts and waits for its upstream PowerShell executor. This is the remaining known slow Windows route. External capture is supported. |
| CodeBuddy | `que-hook.exe` command hook | Native receiver on Windows. Earlier user testing found normal hook delay; external capture needs separate confirmation for the installed version. |
| Pi | Que-owned JavaScript extension | Plugin API route; no Windows command hook. External capture needs an extension discoverable by the installed Pi. |
| OMP | Que-owned JavaScript extension | Plugin API route. `ask` produces `PreToolUse`; when it remains unanswered for the hold window Que promotes it to `HeldAsk` / Attention. External capture needs the installed OMP extension to load. |
| OpenCode v1 | Que-owned JavaScript plugin | V1 function-hook adapter remains supported for card sessions. |
| OpenCode v2 | Que-owned JavaScript plugin package | V2 plugin route remains supported. Do not install the legacy global V1 `opencode-plugin.mjs` into a V2 server: a long-lived OpenCode service can retain it until restarted. |

## What the route names mean

- **Native command hook**: the upstream CLI launches a Que-owned `.exe` for an event. Que controls its runtime, but not the upstream process used to invoke it.
- **Persistent MCP**: the CLI keeps one Que process alive over stdio. Codex uses this to avoid per-event process startup.
- **Plugin/extension**: the upstream CLI loads Que JavaScript in its own plugin host. This is required by Pi, OMP, and OpenCode; replacing it with an exe would not make their plugin APIs available.

## Operational notes

- A running CLI/server may cache its hook configuration. Reinstalling a Que hook changes future sessions; restart the affected CLI service before judging a removed or renamed plugin registration.
- Que-owned registrations are replaced by ownership marker only. User-owned registrations and Grok compatibility switches are not modified.
- The external-capture setting affects only Que's registration. It is not a general upstream-hook switch and is applied when Que synchronizes global hooks.
- Measure the full CLI hook executor separately from the native receiver. The Cursor PowerShell path is the concrete example: moving Que logic into Rust cannot eliminate the executor process that Cursor itself requires.

## Verification boundary

The repository includes headless protocol fixtures in [`scripts/harness-e2e`](../scripts/harness-e2e/README.md). They check process protocol, event delivery, path quoting, and the MCP contract. They do not claim that a fixture's timing is an end-to-end latency measurement for every installed CLI. No graphical verification is required for these routes.
