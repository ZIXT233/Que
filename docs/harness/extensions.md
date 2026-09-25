# Que harness extensions (API v1)

**English** | [简体中文](extensions.zh-CN.md)

The bundled [Qwen Code extension](../../examples/harness-extensions/qwen-code/index.mjs) is a complete API v1 example. This guide follows its code from registration to a Que card and then to an external session. Its [example README](../../examples/harness-extensions/qwen-code/README.md) covers Qwen-specific setup.

## Where the files go

Place a user extension at `~/.que/extensions/<id>/index.mjs`. Development builds use `~/.que-dev/extensions/`; `QUE_DATA_DIR` overrides the data directory. The folder name must match the registered `id`. Que ships its own extensions as application resources: Qwen is available after installing Que and takes precedence over a user copy with the same ID without deleting that copy. Restart Que after changing extension files.

Extensions are trusted Node.js code. Que does not download them. The machine running an extension needs Node.js and the target CLI, such as `qwen`, installed separately. Que copies the extension's UTF-8 text files for each card; symlinks and binary files are unsupported. Keep the entry point and required scripts together. Que's generated `harness-plugins/` copies are separate from the source directory and should not be edited.

## Register the harness

`index.mjs` must default-export a function that calls `que.register(...)` exactly once. Qwen's registration has this shape (the helper functions are defined in its [source](../../examples/harness-extensions/qwen-code/index.mjs)):

```js
export default function activate(que) {
  que.register({
    type: 'harness',
    apiVersion: 1,
    id: 'qwen-code',
    name: 'Qwen Code',
    description: 'Qwen Code CLI and external sessions',
    icon: 'qwen-color.svg',
    launch({ pluginDir, remote }) {
      return launchCommand(pluginDir, remote);
    },
    resume({ pluginDir, remote, sessionId }) {
      return launchCommand(pluginDir, remote, ['--resume', sessionId]);
    },
    installHooks: installCard,
    externalHooks: { install: installExternal, uninstall: uninstallExternal },
    onHook({ event, input, scope }, ctx) {
      // Interpret the CLI event, then call ctx.emit(signal).
    },
  });
}
```

`type`, `apiVersion`, `id`, `name`, and `launch` are required. The other fields are optional, except that `externalHooks` must contain both `install` and `uninstall`. An ID starts with a lowercase letter, contains only lowercase letters, digits, and hyphens, is at most 64 characters, and cannot conflict with a built-in harness. `icon` names a regular SVG beside `index.mjs`, at most 64 KiB; Que displays it in the picker, cards, and external-session settings.

The host imports `index.mjs` and calls its default export during discovery and each action. Do not rely on module globals to retain state between callbacks. The [host implementation](../../src-tauri/resources/bin/extension-host.cjs) defines and validates this API.

## Start and resume a card

`launch(ctx)` returns `{ command, args }`. `command` and each item in `args` must be strings. Que passes them as process arguments and supplies the working directory, terminal, and signal environment. `ctx` contains `cwd`, `remote`, and `pluginDir`; `pluginDir` is the location of this card's copied extension files on the target machine. Use it instead of hardcoding a path on the developer's machine.

Qwen's `launchCommand` uses `node <pluginDir>/launch.cjs` for local Windows cards and `sh <pluginDir>/launch.sh` for macOS, Linux, and SSH cards. The launcher runs `card-settings.cjs`, merges existing Qwen system defaults with the card's hooks, and points `QWEN_CODE_SYSTEM_DEFAULTS_PATH` at the merged file. This keeps card hooks separate from the user's global settings. The Windows launcher hides its child process windows.

`resume(ctx)` receives the same fields plus `sessionId` and returns another `{ command, args }`. Qwen validates the ID and adds `--resume <sessionId>`. Que passes along the ID previously reported by a hook; the CLI decides whether the session still exists. If `resume` is omitted, trying to resume a recorded session returns an error.

## Install hooks for a Que card

`installHooks(ctx)` runs on the target machine before every card start, including SSH hosts. Que has already copied the extension files. `ctx` contains `home`, `remote`, `pluginDir`, and `hookCommand(event)`. This callback may be asynchronous. It can run repeatedly, so preserve user configuration and make writes idempotent.

Qwen's `installCard` writes `<pluginDir>/card-hooks.json`. Its `eventHooks` helper registers `ctx.hookCommand(event)` for each Qwen event. Que provides the complete platform-specific command, including Windows quoting; extension code should not construct the runner command itself. Qwen's launcher then makes Qwen load this card-specific file. For a CLI that loads extension files into its own process, `installHooks` can install those files and `launch` can pass their load arguments using `pluginDir`.

```js
function installCard(ctx) {
  const file = path.join(ctx.pluginDir, 'card-hooks.json');
  const hooks = eventHooks(
    event => ctx.hookCommand(event),
    event => `que-qwen-code-card-${event}`,
  );
  writeSettings(file, { hooks });
}
```

## Handle hook input and report signals

A generated hook command calls `onHook({ event, input, scope }, ctx)`. `input` is the target CLI's stdin JSON, so its fields depend on that CLI. `scope` is `'card'` or `'external'`. `ctx` contains `pluginDir` and `emit(signal)`. `ctx.emit` supplies the harness ID as `kind` and the timestamp as `at`; provide at least `event`. Return nothing when the CLI needs no stdout reply, or return a string or `{ stdout: string }` when it does. Console logging is redirected to stderr to keep stdout available for replies.

Qwen validates the event and scope, copies `session_id` and `cwd` to `sessionId` and `workspaceRoot`, and calls `ctx.emit(signal)`. It maps Qwen's `SessionEnd` to Que's `sessionEnd`. On start, prompt, and stop events it reads Qwen's JSONL transcript when available to add `title`, `firstPrompt`, and recent `turns`. It takes the new user message from `submitted_prompt` and the reply preview from `last_assistant_message`. `tool_name` and `agent_id` become `tool` and `agentId`. Reading that transcript is Qwen-specific code in [index.mjs](../../examples/harness-extensions/qwen-code/index.mjs), not a Que API.

The essential signal path in Qwen's `onHook` is:

```js
const signal = { event: event === 'SessionEnd' ? 'sessionEnd' : event };
if (typeof input?.session_id === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.session_id)) {
  signal.sessionId = input.session_id;
}
if (typeof input?.cwd === 'string' && input.cwd) signal.workspaceRoot = input.cwd;
if (!signal.sessionId && !signal.workspaceRoot) return;
// Qwen also enriches the signal with transcript data when available.
ctx.emit(signal);
```

| Signal event | Card effect |
| --- | --- |
| `SessionStart` | Startup finished; waiting for the user |
| `UserPromptSubmit` | Working |
| `PreToolUse` / `PostToolUse` | Working |
| `PermissionRequest` | Waiting for an explicit user action |
| `Stop` / `StopFailure` | Turn finished; waiting for the user |
| `sessionEnd` | Treated as a finished turn |

Other fields include `prompt`, `replyPreview`, `firstPrompt`, `title`, `turns`, `tool`, `agentId`, and `workspaceRoot`. `turns` is a chronological array of `{ role: 'user' | 'assistant', text: string }`. For external notices, provide a stable `sessionId` or `workspaceRoot` so Que can identify the session. A session ID starts with a letter or digit, may then contain letters, digits, underscores, or hyphens, and is at most 128 characters. Subagent events with `agentId` do not change the main card's state. Use `PermissionRequest` only when the CLI actually needs user action. See the [full signal contract](hook-api.md).

An extension file loaded inside the target CLI can import `emit(kind, signal)` from `extension-host.cjs` in `pluginDir`'s parent directory. Que sets `QUE_HARNESS_KIND` and `QUE_HARNESS_SIGNAL_DIR` locally, or `QUE_HARNESS_CHANNEL` and `QUE_HARNESS_TTY` remotely. Qwen uses command hooks and `ctx.emit` instead.

## Capture sessions started outside Que

`externalHooks` is optional and requires both `install(ctx)` and `uninstall(ctx)`. It handles local sessions started outside Que. External notices are off by default; enable them and the harness in Que's external-session settings. These callbacks run locally. `ctx` contains `home`, `pluginDir`, `externalSignalDir`, and `hookCommand(event)`.

Qwen's `installExternal` merges its command hooks into `~/.qwen/settings.json`. Its hook names include a stable hash derived from `ctx.pluginDir`, allowing `.que` and `.que-dev` to coexist. `uninstallExternal` removes only entries owned by the same Que instance, preserving other settings and hooks. Que installs when enabled and uninstalls when disabled or the extension is removed. The generated external hook skips sessions launched by Que, so those cards still need their own hooks. Outside sessions reach `onHook` with `scope: 'external'`. External notices still depend on Que's settings.

The same `eventHooks` helper registers Qwen events for either scope. `installExternal` supplies `ctx.hookCommand(event)` and an instance-specific name, while `uninstallExternal` uses `removeOwned(settings, ctx)` to remove just those entries. See both functions in [Qwen's source](../../examples/harness-extensions/qwen-code/index.mjs).

External hooks currently install only on the local machine; sessions started outside Que on an SSH host are not captured. An extension file loaded inside a CLI can use `emit(kind, signal, { externalSignalDir: ctx.externalSignalDir })` to reach the external sink when no card signal environment exists.

## SSH and diagnosis

Before an SSH card starts, Que uploads the UTF-8 extension files and runs `installHooks` remotely. Signals use an OSC channel through `QUE_HARNESS_TTY`; if a hook cannot write to that TTY, delivery is not guaranteed. Check a real remote session while developing remote support.

For diagnosis, enable Detailed debug logging in Que's settings and inspect `~/.que/logs`, or use the card's Logs button to save and open its report. Check that hook events arrived, `sessionId` was bound, and the card state changed. Successful file installation alone does not prove that hooks are working.
