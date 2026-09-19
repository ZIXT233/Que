# Windows hook verification — 2026-09-20

User-confirmed baseline: Claude, Pi and OpenCode have no noticeable hook delay.
This investigation does not change their runtime behavior.

## Confirmed fixes

- Codex npm launcher: `cmd /c call codex.cmd` reinterprets nested TOML quotes
  and `&&` inside `-c`. A recorder using the official npm shim reproduced the
  argument ending at `command="pushd .`, with the remaining arguments lost.
  Que now recognizes the official npm shim and invokes its JS entrypoint with
  Node and separate arguments. Native exe launches and custom shims are unchanged.
  This preserves the official entrypoint's architecture/environment setup.
- Codex hook: `pushd . && cd /d <plugin directory> && call hook.cmd` saves the
  original cwd. The batch captures its script path, restores cwd with `popd`,
  then invokes the quoted Node executable. Space, Chinese and `&` paths,
  UTF-8 stdin and exit code propagation passed a real cmd regression test.
  Unsupported expansion characters and UNC plugin paths retain the old fallback.
- Antigravity ownership: recognize `.que-dev` and legacy encoded PowerShell
  commands, not only quoted `.que` paths. Installation and removal both check
  ownership. Tests cover migrations and rejection of foreign/mixed bundles.
- Cursor: installed `2026.09.18-9a7762b` wraps Windows hook commands with the
  PowerShell call operator in both heredoc and temp-file transports. Supply
  single-quoted executable/arguments without starting another PowerShell.
- CodeBuddy: installed `2.155.0` defaults hook execution to Bash unless a hook
  explicitly selects PowerShell. Que uses POSIX quoting and forward-slash drive
  paths, avoiding the nested PowerShell wrapper.

## Verification

- `cargo test --manifest-path src-tauri/Cargo.toml --lib harness::kinds -- --test-threads=1`
- `cargo test --manifest-path src-tauri/Cargo.toml --lib harness::windows::tests -- --test-threads=1`
- `node node_modules/typescript/bin/tsc --noEmit`
- `node scripts/test-windows-hook-launch.cjs`
- `node scripts/test-windows-hook-launch.cjs --config-only`
- `node scripts/test-windows-hook-launch.cjs --cursor-only`

The CLI checks use temporary homes/signals and do not submit model requests.
The Codex check uses the installed official JS entrypoint and `features list` to
verify actual config parsing. The old npm shim is tested with an argv recorder,
not an interactive Codex process.

Observed shell/ingress timings (three samples, milliseconds; not full CLI turns):

| Case | Old nested PowerShell | Direct Node within existing shell |
| --- | --- | --- |
| Cursor, alternating pairs | 5143, 4372, 4225 | 6317, 2212, 2142 |
| CodeBuddy | 7392, 8506, 8517 | 226, 228, 241 |

Cursor still starts its own PowerShell and shows substantial cold-start/load
variance. These samples do not establish that all Cursor latency is fixed.
Both new paths returned the expected verdict and preserved the test payload.
The UTF-8 temp-file fixture has a BOM: Windows PowerShell 5.1 otherwise reads
Cursor's encoding-unspecified `Get-Content` as the local codepage and corrupts
Chinese before the hook runs. Que does not guess how to reverse that corruption.

## Other adapters

- Gemini's current upstream `HookRunner` uses `getShellConfiguration`, selecting
  PowerShell on Windows. Its Que command now uses the existing shell's call
  operator rather than launching an additional shell. No live Gemini CLI test.
- Grok supports configurable Windows shells (`GROK_SHELL=cmd` versus PowerShell).
  Antigravity's public hook docs do not specify the Windows executor, and the
  installed `agy.exe` is native. Neither is claimed performance-verified;
  they retain the compatible fallback rather than assuming cmd syntax.
- Pi/OMP and OpenCode use in-process extensions/plugins rather than this command
  hook chain. Claude uses executable plus args.

Sources: installed Cursor bundles (`190.index.js`, `index.js`) and CodeBuddy
`dist-server/9552.codebuddy.js`; [CodeBuddy guide](https://www.codebuddy.ai/docs/cli/hooks-guide),
[Gemini hook runner](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/hooks/hookRunner.ts),
[Gemini shell selection](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/utils/shell-utils.ts),
[Grok hook reference](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/custom-hooks.md).
