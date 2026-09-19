# Windows Codex interactive hook trace

Actual installed Codex 0.155.0 TUI, normal user config/auth/model (gpt-5.6-luna),
repository cwd, existing Que external registrations. No Que UI or mock provider.
Only opt-in ingress diagnostics and process observation were added. The terminal
was the tool PTY, not Windows Terminal. First capture used TERM=dumb (confirmed
the CLI prompt); tool-call captures used TERM=xterm-256color.

## Observed tool boundary

Requested exactly one read-only `echo QUE_HOOK_TIMING`, no file operations.
Paired rollout custom calls/results by call_id:

| Condition | Tool boundary |
| --- | ---: |
| Hooks on, first tool call | 15,164 ms |
| Hooks disabled for this invocation | 1,163 ms |
| Hooks on again, resumed enabled session | 4,584 ms |

First enabled session: `01a0baea-2d15-7272-b660-35700217343d`.
Disabled session: `01a0baec-9402-7160-9412-8635020890a0`.
The disabled capture produced no Que hook log; enabled captures did.
The first enabled call created Windows sandbox setup processes. Thus the first
15-second result must not be labelled entirely hook overhead. These are single
samples, not a controlled latency distribution; resumed and fresh sessions differ.

In the first enabled tool call the JS hook lifecycle measured about 102 ms for
PreToolUse and 31 ms for PostToolUse, excluding Node/shell startup. This does not
explain total latency. WMI events identify ancestry (Codex -> pwsh -> Node), but
TIME_CREATED is delayed provider emission time and cannot measure process life.
The report deliberately does not calculate durations from WMI timestamps.

## Protocol alternatives verified

The installed 0.155.0 parser rejects `type="http"` with expected variants
`command`, `mcp_tool`, `prompt`, `agent`. It accepts an `mcp_tool` hook definition.
This is parser verification, not proof of event delivery or latency improvement.
Current official docs describe hooks calling already-connected MCP tools and
background command hooks. SessionStart can occur before MCP becomes ready, and
async hooks can finish out of order; neither should be enabled blindly for queue
state transitions.

Sources: https://github.com/openai/codex/issues/41942 and
https://developers.openai.com/codex/hooks . The issue retracts several original
claims; its surviving measurements are evidence for investigation, not proof of
the cause on this machine.

No latency fix is claimed by this capture. The isolated no-tool exec test does
not validate the interactive tool-hook path.

## Implemented transport

Codex production hooks now use one persistent stdio MCP server per session.
The server calls the existing ingress normalization and signal writer in-process.
No command-hook fallback or extra version probe is retained. Direct executable
and argument fields also avoid shell quoting/short-path workarounds.

Real TUI checks caught two issues that the isolated contract did not: Codex
combines user and session hooks (explicit internal/external scopes prevent double
signals), and Codex filters the MCP environment (env_vars must forward Que card,
TTY and tmux routing variables). Global registration is migrated by ownership;
user-owned adjacent hooks and MCP servers are preserved.

An external TUI turn using production ingress delivered SessionStart, submit,
PreToolUse, PostToolUse and Stop once each, with DONE as the completion preview.
Evidence: que-codex-mcp-DPlIiL under the local temporary directory. Its overall
tool boundary was 6317 ms; that includes shell/sandbox work and is not an MCP
hook timing. Do not present this sample as a guaranteed end-to-end speedup.

Final internal TUI check after explicit environment forwarding:
`que-codex-mcp-LbluwT/report.json`, session
`01a0bb00-6115-73c1-be83-d318a8bc2867`. Two actual model/tool turns produced
SessionStart once and submit/PreToolUse/PostToolUse/Stop twice each; all nine
signals reached the internal sink and none reached the external sink. All events
used one MCP worker PID. Handler processing including file writes took 1.4–9ms.
This is handler time, not end-to-end latency. Tool boundaries were 7082ms then
1096ms; the second prompt explicitly requested login=false, so these are not a
controlled speedup ratio. The second PreToolUse arrived 33ms after the tool-call
record and PostToolUse was recorded 5ms before the result record. No per-hook
shell/Node spawn is present in this transport.

Production Rust code compiled and all 12 Codex tests passed in a separate target
directory. The persistent protocol contract passed both sinks, all six events,
two turns, Unicode paths, opposite-scope suppression and completion previews.
