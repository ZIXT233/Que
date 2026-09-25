# Qwen Code harness extension example

**English** | [简体中文](README.zh-CN.md)

Que ships this extension as an application resource and loads it at startup. Development
builds read this source directory directly. No copy to `~/.que/extensions/` is needed.
That directory remains for user extensions; an existing Qwen copy is preserved, but the
bundled version takes precedence. Restart Que after changing extension files.
Node.js and the `qwen` CLI must be available on the target machine.

The extension supplies its own `qwen-color.svg` icon. Its external hooks register in
`~/.qwen/settings.json` only when external notices are enabled. Hook names include a stable
identifier for the Que data directory, so multiple Que installations can register together.
Uninstalling the extension or disabling its external hooks removes only its own entries.

The external hook reads Qwen Code's JSONL transcript to provide the session title and recent
user and assistant messages. On `UserPromptSubmit`, it uses `submitted_prompt` for the new
user message. If the transcript is unavailable, it reports the fields supplied by the hook.

Que cards use `launch.sh` on macOS/Linux and remote hosts, and `launch.cjs` on local Windows,
with per-card hooks instead of the external registration. The launchers merge existing Qwen
system defaults into a temporary per-card file. Resuming a session calls
`qwen --resume <session-id>`.

Qwen Code loads hooks when a session starts. For an already-open session, use its `/hooks`
menu to reload them. Qwen Code's `disableAllHooks`, `--safe-mode`, and `--bare` options disable
hooks.

See the [Que extension guide](../../../docs/harness/extensions.md) and the
[Qwen Code hook documentation](https://qwenlm.github.io/qwen-code-docs/en/users/features/hooks/).
