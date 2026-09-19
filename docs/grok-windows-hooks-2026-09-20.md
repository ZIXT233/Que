# Grok Windows hook transport — 2026-09-20

Installed CLI: Grok 1.0.34 (3736acbc8658), Windows ARM64.

## Decision

Grok supports native HTTP handlers, but its runner only permits HTTPS, including
loopback. Its environment expander deliberately preserves shell modifier forms
such as `${VAR:-default}`; they do not work as HTTP URL defaults. The initial HTTP
prototype failed against the actual CLI and was removed. Que does not install a
trusted root certificate or publish a network endpoint to work around this.

Verified upstream implementation:

- [HTTP validation](https://github.com/xai-org/grok-build/blob/4247f661689354b831191f11eeeac8424993fe3d/crates/codegen/xai-grok-hooks/src/runner/http.rs)
- [Environment expansion](https://github.com/xai-org/grok-build/blob/4247f661689354b831191f11eeeac8424993fe3d/crates/codegen/xai-grok-hooks/src/env_expand.rs)
- [Direct command execution](https://github.com/xai-org/grok-build/blob/4247f661689354b831191f11eeeac8424993fe3d/crates/codegen/xai-grok-hooks/src/runner/command.rs)

On Windows the managed hook now contains only `que-session-state.exe`, relative
to the hook JSON directory. Grok directly spawns this file; there are no shell
tokens, arguments, PowerShell, short-path aliases, or Node child processes.
The tiny Rust executable writes the raw event envelope atomically. Que normalizes
it through the existing signal watcher and state machine. Per-card environment
selects the internal sink; external sessions use the active dev/release profile's
saved sink. macOS/Linux/SSH retain their existing transport.

Claude's imported registration still starts its small ambient launcher, which
immediately exits for Grok without starting Node or duplicating the signal.
Cursor's existing compatibility-safe registration remains in place. No Grok
compatibility switches are changed by installation.

## Runtime evidence

The first direct executable + Node attempt still measured 1057/832/881/247ms
inside Grok. Node was consequently removed from the Grok path.

Native-only samples (Grok's elapsed_ms, full hook execution, not just handler code):

- Cold sample: 1178ms SessionStart; 146ms submit; 173/175ms Stop.
- Next sample: 267ms SessionStart; 57ms submit; 178/205ms Stop.
- Complete compatibility-on suite: 455ms SessionStart; 342ms submit; 143/156ms Stop.
  Imported Claude no-op handlers additionally measured 428/184/200/197ms.

Do not describe this as guaranteed sub-second startup. CLI initialization/model
catalog work is separate, and the local fixture's full external CLI run took
21.3s. Grok emits Stop both at turn completion and at shutdown; the empty shutdown
event now preserves the current reply preview, while a new Working event clears it.

Full suite evidence before the final signal-drain concurrency check:

- `%TEMP%/que grok native 中文-1uE9RY/report.json`: actual external CLI, production
  registration, native durations and compatibility handlers.
- `%TEMP%/que-e2e-TDFueB/case-0/report.json`: real interactive CLI through Que PTY;
  two Working → Attention transitions with correct queue membership, no external
  routing leak. Queue observation after submit was 458ms / 904ms; model fixture
  delay and watcher polling are included in state observation times.

The fixture is `scripts/harness-e2e/grok-native.mjs`. No GUI verification was used.

Final rebuilt-suite pass after serializing signal-file consumption:

- `%TEMP%/que grok native 中文-na46XS/report.json`: native hook durations
  **132 / 122 / 52 / 39ms**; imported Claude no-ops **157 / 68 / 46 / 47ms**.
  Whole external CLI execution was 17.43s, including initialization and fixture
  model work. This is not an overall CLI-startup performance claim.
- `%TEMP%/que-e2e-q3mKhi/case-0/report.json`: exact event-count assertions pass:
  SessionStart once, UserPromptSubmit twice, Stop twice. Both turns move through
  the real queue correctly, with no internal-to-external leak.
- Five Grok-focused tests and all 22 external-notice tests pass, including
  preservation of multiline replies on empty shutdown Stop and clearing them
  when the next turn starts. Native envelope parsing rejects unknown events.

The headless terminal fixture currently includes a replayed DA1 reply prefix in
the first submitted prompt. Lifecycle/queue assertions pass, but this suite does
not certify terminal capability-response handling or exact prompt text.
