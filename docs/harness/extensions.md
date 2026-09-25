# Que Harness Extensions (API v1)

**English** | [简体中文](extensions.zh-CN.md)

Place a user extension in `~/.que/extensions/<id>/` with an `index.mjs` entry point.
Development builds use `~/.que-dev/extensions/`; `QUE_DATA_DIR` overrides the data
directory. The directory name must match the registered `id`. Extensions are
trusted, user supplied Node.js code. Que does not install them from the network.
The target machine needs Node.js.
Que ships its own extensions as application resources and loads them automatically.
They update with Que and take precedence over a same-id user extension without deleting it.
The [Qwen Code extension](../../examples/harness-extensions/qwen-code/README.md) shows a
complete bundled extension with an icon, per-card hooks, and external session hooks.

The current uploader copies UTF-8 text files from the extension directory. Keep
the entry point and required scripts there; symlinks and binary assets are not
supported. Install or configure any other remote dependencies separately.

Que loads extensions at startup. Call `POST /api/extensions/harnesses` to reload
them while Que is running. `GET /api/extensions/harnesses` returns the loaded
harnesses and the most recent load errors without scanning the directory. A registered harness
appears in the new session picker. Leave Que's generated `harness-plugins/`
directory alone; it is separate from the extension source directory.
An optional `icon` names a regular `.svg` file beside `index.mjs` (up to 64 KiB).
Que carries it with the extension and displays it in the picker, cards, and
external-session settings. Extensions without one keep the default icon.

An extension can also opt into notices for local sessions launched outside Que
with `externalHooks`. External notices are disabled by default. Enable them in
Que's existing external sessions settings after registering the extension.

```js
// ~/.que/extensions/example/index.mjs
import fs from 'node:fs';
import path from 'node:path';

export default function activate(que) {
  que.register({
    type: 'harness',
    apiVersion: 1,
    id: 'example',
    name: 'Example Agent',
    description: 'Example Agent CLI',
    // icon: 'icon.svg', // Optional SVG beside index.mjs, at most 64 KiB.

    launch({ pluginDir }) {
      return { command: 'example-agent', args: [] };
    },

    async installHooks(ctx) {
      // This can run repeatedly. Preserve configuration owned by the user.
      const stopCommand = ctx.hookCommand('Stop');
      const config = path.join(ctx.home, '.example-agent', 'config.json');
      const current = fs.existsSync(config) ? JSON.parse(fs.readFileSync(config, 'utf8')) : {};
      current.hooks ??= {};
      current.hooks.Stop = [
        ...(current.hooks.Stop || []).filter(item => item.queOwner !== 'example'),
        { queOwner: 'example', command: stopCommand },
      ];
      fs.mkdirSync(path.dirname(config), { recursive: true });
      fs.writeFileSync(config, JSON.stringify(current, null, 2));
    },

    onHook({ event, input }, ctx) {
      ctx.emit({ event, sessionId: input.session_id });
      // Return a string or { stdout: string } if the agent needs a stdout reply.
    },

    resume({ sessionId }) {
      return { command: 'example-agent', args: ['--resume', sessionId] };
    },
  });
}
```

## Callbacks

- `launch(ctx)` returns `{ command, args }`. Que supplies the working directory,
  terminal, and signal environment. `ctx` contains `cwd`, `remote`, and
  `pluginDir`. Use `pluginDir` for extension files instead of hardcoding a path
  on the local machine.
- `installHooks(ctx)` runs on the target machine before the terminal starts.
  `ctx` contains `home`, `remote`, `pluginDir`, and `hookCommand(event)`. It may
  edit the target agent's configuration or install a Pi style extension. Que
  can call it on every launch, so make it idempotent and preserve user hooks.
- For command based hooks, `ctx.hookCommand(event)` returns the full command.
  When the agent invokes it, Que passes its stdin JSON to
  `onHook({event,input},ctx)`. Call `ctx.emit(signal)` to report a signal. Return
  `undefined` when no stdout reply is needed. Return a reply only when the
  target agent requires one; Que observes permission requests and does not
  make authorization decisions for the user.
- An in-process extension, such as Pi's, can install its files in `installHooks`
  and use `pluginDir` in `launch` to add its load arguments. Such files can send
  signals directly through `emit(kind, signal)`, exported by the
  `extension-host.cjs` file in `pluginDir`'s parent directory. Que sets
  `QUE_HARNESS_KIND` and `QUE_HARNESS_SIGNAL_DIR` locally, or
  `QUE_HARNESS_CHANNEL` and `QUE_HARNESS_TTY` remotely.
- `resume({sessionId,cwd,remote,pluginDir})` returns the resume command. Que
  stores the hook reported `sessionId` and passes it back unchanged; the target
  CLI decides whether the session still exists. For more complex recovery,
  return `node` with the path of a script in the extension directory. You may
  omit `resume` if the CLI cannot resume, but attempting to resume a recorded
  session will then return an explicit error.

## External session hooks

Add `externalHooks` to the same `type: 'harness'` registration when the target
agent has user-level hooks. Both callbacks are required:

```js
externalHooks: {
  install(ctx) {
    const command = ctx.hookCommand('Stop');
    // Add a hook owned by this extension to the agent's user-level config.
    // Keep the user's entries and make repeated installs safe.
  },
  uninstall(ctx) {
    // Remove only this extension's user-level hook entries.
  },
},
onHook({ event, input, scope }, ctx) {
  ctx.emit({ event, sessionId: input.session_id, workspaceRoot: input.cwd });
},
```

`install(ctx)` and `uninstall(ctx)` run locally. Their context contains `home`,
`pluginDir`, `externalSignalDir`, and `hookCommand(event)`. Que copies the
extension to `harness-plugins/<id>/global/` and runs `install` when external
notices and this harness are enabled. It runs `uninstall` when either is
disabled or the extension is removed. `POST /api/extensions/harnesses` reloads
extensions and reconciles their external hooks; install errors appear in its
`errors` response. Settings updates return any `extensionErrors`.

More than one Que data directory can run on the same machine, such as `.que`
and `.que-dev`. Use `ctx.pluginDir` to identify the owning instance in the
agent's user-level config. `install` should replace only that instance's
entries, and `uninstall` should remove only those entries. If the agent keys
hooks by name or filename, derive a stable instance suffix from `ctx.pluginDir`
for the name or filename as well.

A command returned by the global `hookCommand` reports to the external notice
sink when it runs without a Que card's signal environment. The generated
global hook skips sessions launched by Que; `installHooks` or `launch` should
register the card's own hooks. `onHook` receives `scope: 'card' | 'external'`.
For external notices, emit a stable `sessionId` or a `workspaceRoot` so Que can
identify the session. Que's external notice settings still gate delivery.
For an in-process adapter, the exported `emit(kind, signal,
{ externalSignalDir: ctx.externalSignalDir })` can explicitly send an external
signal when no card environment is present.

`command` and every item in `args` must be strings. Que does not join them
through the user's shell. An `id` must start with a lowercase letter and
contain only lowercase letters, digits, and hyphens, with a maximum length of
64 characters. It cannot conflict with a built-in harness.

## Signals

`ctx.emit` accepts the existing `HookSignal` fields. Que fills in `kind` and
the timestamp. Supply at least `event`, and report `sessionId` as early as
possible. Session IDs may contain letters, digits, underscores, and hyphens,
must start with a letter or digit, and have a maximum length of 128 characters.
Common events are:

| Event | Card behavior |
| --- | --- |
| `SessionStart` | Startup finished; waiting for the user |
| `UserPromptSubmit` | Working |
| `PreToolUse` / `PostToolUse` | Working |
| `PermissionRequest` | The target agent is explicitly waiting for the user |
| `Stop` | Turn finished; waiting for the user |

You can also provide `prompt`, `replyPreview`, `title`, `turns`, `tool`, and `agentId`.
`turns` is a chronological array of `{ role: "user" | "assistant", text: string }`
read from the harness's own conversation record for external session notices.
Subagent events carrying `agentId` do not change the main card's state. Do not
report an ordinary tool start as `PermissionRequest`. See the
[full signal contract](hook-api.md).

## Remote use and debugging

Before an SSH session starts, Que uploads the extension files and runs
`installHooks` remotely. The remote side sends signals through an OSC channel
on `QUE_HARNESS_TTY`. If the target agent's hook cannot write to that TTY,
delivery is not guaranteed by this interface; check a real remote session.

After startup, inspect `GET /api/harness/<terminal-id>/debug`. Confirm that
Que received hook events, bound the `sessionId`, and changed the card state.
The presence of files or a successful install command alone does not prove the
integration works. API v1 manages sessions launched by Que; it does not
automatically capture sessions started outside Que unless `externalHooks` is
registered and external notices are enabled. External hooks currently install
on the local machine; SSH sessions outside Que are not captured.
