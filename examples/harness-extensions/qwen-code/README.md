# Qwen Code harness extension example

**English** | [简体中文](README.zh-CN.md)

This example is installed separately. Keeping it in this repository does not load it into Que.

From the repository root, install it with:

```sh
mkdir -p ~/.que/extensions
cp -R examples/harness-extensions/qwen-code ~/.que/extensions/
```

Development builds use `~/.que-dev/extensions/` instead. Start Que after copying, or reload
extensions through `POST /api/extensions/harnesses`. Node.js and the `qwen` CLI must be
available on the target machine.

The extension supplies its own `qwen-color.svg` icon. Its external hooks register in
`~/.qwen/settings.json` only when external notices are enabled. Hook names include a stable
identifier for the Que data directory, so multiple Que installations can register together.
Uninstalling the extension or disabling its external hooks removes only its own entries.

The external hook reads Qwen Code's JSONL transcript to provide the session title and recent
user and assistant messages. On `UserPromptSubmit`, it uses `submitted_prompt` for the new
user message. If the transcript is unavailable, it reports the fields supplied by the hook.

Que cards use `launch.sh` and per-card hooks instead of the external registration. The script
merges existing Qwen system defaults into a temporary per-card file; it is intended for macOS
and Linux. Resuming a session calls `qwen --resume <session-id>`.

Qwen Code loads hooks when a session starts. For an already-open session, use its `/hooks`
menu to reload them. Qwen Code's `disableAllHooks`, `--safe-mode`, and `--bare` options disable
hooks.

See the [Que extension guide](../../../docs/harness/extensions.md) and the
[Qwen Code hook documentation](https://qwenlm.github.io/qwen-code-docs/en/users/features/hooks/).
