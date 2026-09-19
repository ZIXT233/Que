# Real CLI headless integration checks

## Grok on Windows: native hook runner

`node scripts/harness-e2e/grok-native.mjs QUE_HEADLESS_EXE GROK_EXE`
uses the installed Grok CLI and production hook registration in a temporary
profile whose path contains spaces and Chinese characters. It checks a real
external turn, reply preview after CLI shutdown, and two interactive turns via
Que's PTY/API/queue. Claude and Cursor compatibility are enabled, with their
actual Que registrations installed. A local model fixture avoids paid requests;
this is a transport/state test, not a model or total-startup benchmark.

The report keeps Grok's own complete hook durations, including process startup,
and imported compatibility hook durations. The budget is 2s for the first cold
SessionStart and 1s for subsequent hooks. It rejects hook failures and incorrect
queue placement. See `docs/grok-windows-hooks-2026-09-20.md` for measured results
and why native HTTP was not used.

## Diagnose the ordinary external Codex TUI on Windows

Run `./scripts/harness-e2e/trace-codex.ps1` from the same directory and shell as
the affected session. It invokes ordinary `codex` with the existing user config,
auth, sandbox, model and hook registrations. It does not use `codex exec` or a
mock provider. The installed Que ingress must contain the current diagnostics.
Only the child environment enables `QUE_HOOK_DEBUG` and redirects diagnostics
to a unique temporary directory. Exit Codex normally to finish the capture.

`node scripts/harness-e2e/trace-codex-report.mjs TRACE_DIRECTORY` correlates hook
PIDs with process ancestry. WMI reports process events in batches: its timestamps
are **not** exact process creation/exit times and must not be used to calculate
latency. Hook marks use monotonic elapsed times, but exclude runtime startup.
Raw process events contain system-wide process names/IDs, without command lines.
The generated report filters to the captured launcher descendants.

`node scripts/harness-e2e/codex-rollout-timing.mjs ROLLOUT_JSONL` pairs both
function and custom tool calls by `call_id`. The result measures the whole tool
boundary, including sandbox/code-mode/shell work, not solely hooks. For an A/B
control, pass `-CodexArgs @('--disable','hooks')` to the tracer, then repeat the
enabled condition to check warm-up effects. Confirm actual hook marks in the
enabled run and their absence in the disabled run. No global toggle is changed.

The earlier isolated no-tool `codex-turn.cjs` test is a command/serialization
check; passing it does not establish acceptable interactive hook latency.

## Persistent Codex MCP transport

`node scripts/harness-e2e/codex-mcp-contract.cjs` exercises the production MCP
server and shared ingress, both internal/external sinks, all six events, two
turns, preview content, and rejection of the opposite registration scope.

`node scripts/harness-e2e/codex-mcp-tui.cjs PATH_TO_CODEX_JS` runs the actual
interactive CLI with production scripts in a unique temporary directory and
per-card hook definitions. Existing global hooks remain loaded to detect double
delivery. Add `--external` to use the existing global definitions instead.
This test uses real auth/model requests and a per-invocation hook trust bypass;
production registration never bypasses trust. Use a read-only echo prompt, then
exit normally. Inspect the reported directory's signal files and pair the
resulting rollout's tool calls with `codex-rollout-timing.mjs`.

Codex MCP registration is now the only production transport; no CLI version
probe or command fallback is added. Ownership migration remains necessary for
existing development registrations. SessionStart can precede MCP readiness per
upstream; the later submit event also carries the session ID and working state.

This drives an already running local Que server through its actual HTTP API,
PTY, installed CLI, hook and queue reducer. `@xterm/headless` consumes terminal
output and replies to terminal queries without opening a browser. No Rust test
binary or application rebuild is required by the runner.

```sh
npm install --prefix scripts/harness-e2e
node scripts/harness-e2e/run.mjs --base http://127.0.0.1:YOUR_QUE_PORT --manifest scripts/harness-e2e/cases.example.json --allow-model-requests
```

Use an empty test Que profile; the runner refuses a queue containing cards because
workspace selection can otherwise reuse a user's draft. Internal launch uses the same
hook installation path as normal cards, including user-level CLI registration.
The runner does not change capture settings or authenticate CLIs for you.
External capture must already be enabled. External scenarios launch an ordinary
shell terminal with the CLI command, without Que's per-card harness environment.
They therefore test automatic plugin discovery and the configured notification sink.

The explicit flag acknowledges real model requests and possible usage charges.
These are live integration tests: model latency, login/trust screens and network
failures can cause failures. They are not a deterministic mock-provider suite.
Adjust startup screen patterns and explicit input steps for your installed CLI.
Do not make missing plugins or trust screens into skipped/passed checks.

Each case uses a new temporary directory and its own card/terminal. Cleanup closes
only those resources. The printed report directory retains raw terminal text,
final screen, queue/hook snapshots, step timings and errors. Ctrl+C requests cleanup.
Never put secrets in test prompts: reports contain test transcript text.

Cases support `send`, `screen` (regex), `hook` (fresh event since last send),
`state` (internal harness state), `externalState`, `waitMs`, and `timeoutMs`.
Combine a fresh completion hook and attention state with the expected answer;
screen text alone can be just the echoed prompt. Test at least two turns to catch
initial-success/later-failure regressions. For other harnesses copy a case and
change `kind`, ordinary external `command`, ready pattern, and native event names.
OMP uses Pi's external-capture switch.

CLI hook errors fail immediately. A continuously visible `running hook` longer
than `maxRunningHookMs` (default 3000) fails even if the backend already received
a working signal. This is a UI-text observation, not an exact child-process
duration measurement; CLIs that do not render hook activity need runner-specific
instrumentation. This suite does not prove every child exited successfully just
because it saw a hook event. The earlier `test-windows-hook-launch.cjs` is only a
shell/serialization microbenchmark, not equivalent to this suite.

The example cases have not been certified against all installed CLI versions.
Keep failures and reports; do not call unexecuted cases verified.

## Codex executor regression without a Que build

`codex-startup.cjs --entry PATH_TO_OFFICIAL_CODEX_JS --command ACTUAL_HOOK_COMMAND`
runs the installed Codex SessionStart executor, checks its Completed/Failed result
and the actual signal file, and records the interval between the CLI's hook start
and completion messages. `--expect-failure` pins a known bad command as a negative
control. It uses an unavailable loopback provider and stops after the hook result;
it sends no prompt to a model provider. It does not test the full turn or queue.

Windows Codex 0.155.0 observed on 2026-09-20: the old `pushd ... && cd /d ... &&
call hook.cmd` registration failed; direct bare Node + ingress succeeded, with a
613 ms hook interval in one sample. This is not a latency guarantee.

## Deterministic installed-CLI checks

These scripts use isolated temporary profiles and a local model fixture. They run
the installed CLI and actual hook/extension discovery, without a Que build or GUI.
They do not exercise Que's queue reducer; use `run.mjs` for that final boundary.
Reports stay in the printed temporary directory. Their durations include CLI and
model setup, not just hook execution, and vary substantially under machine load.

```sh
cargo build --manifest-path src-tauri/hook-runtime/Cargo.toml --locked --release --target-dir PATH_TO_TEMP
# Executable: PATH_TO_TEMP/release/que-hook.exe
node scripts/harness-e2e/launcher.cjs PATH_TO_TEMP/que-hook.exe
node scripts/harness-e2e/compat-cli.cjs --launcher PATH_TO_TEMP/que-hook.exe --claude PATH_TO_CLAUDE_EXE --grok PATH_TO_GROK_EXE
node scripts/harness-e2e/extensions-cli.cjs --pi-entry PATH_TO_PI_JS --omp PATH_TO_OMP_EXE
node scripts/harness-e2e/omp-ask.cjs PATH_TO_OMP_EXE
node scripts/harness-e2e/codebuddy-cli.cjs PATH_TO_CODEBUDDY_JS
node scripts/harness-e2e/codex-turn.cjs PATH_TO_CODEX_JS
node scripts/harness-e2e/cursor-executor.cjs PATH_TO_CURSOR_INDEX_JS PATH_TO_TEMP/que-hook.exe
```

- `launcher.cjs`: real child processes, Unicode/spaced paths, imported-hook and
  ambient internal-hook suppression. A helper test, not a CLI E2E.
- `compat-cli.cjs`: Claude full turn; Grok with Claude compatibility off/on, plus
  an old-registration negative control that must reproduce a hook failure.
  Uses a spaced Unicode profile and its Windows short path. Add
  `--cursor-compat-fixture` to reproduce Grok's current upstream failure parsing
  native Cursor hook entries (`missing field hooks`). This case deliberately fails.
- `extensions-cli.cjs`: real Pi and OMP external automatic discovery and internal
  explicit extension loading, exactly one submit/completion per turn.
- `omp-ask.cjs`: real OMP `rpc-ui`, deterministic built-in ask tool call, wait with
  no answer, verify pending signal, answer, verify resume/completion. Ordinary RPC
  does not enable the ask tool and is not an equivalent test.
- `codebuddy-cli.cjs`: ambient user settings, full turn, external signals.
- `codex-turn.cjs`: complete local Responses-model turn through the installed
  Codex executor, exactly one SessionStart, UserPromptSubmit and Stop, no hook error.
  Uses the fixture machine's `C:/PROGRA~1/nodejs/node.exe` alias and fails explicitly
  if unavailable; it does not prove arbitrary Windows path installation.
- `cursor-executor.cjs`: loads the installed Cursor hook executor without its main
  entrypoint and runs both payload transports through real PowerShell. Does not
  modify the installation. This is an executor integration test, not a full Cursor
  turn or a measurement of Cursor's production shell driver. Bundle changes fail
  explicitly instead of silently using a fake implementation.

Fixtures provide dummy credentials and local model endpoints; they do not consume
paid model tokens. CLI background update/telemetry traffic is not network-sandboxed.
