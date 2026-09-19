# OpenCode V2 status adapter

The supplied 2.0.10 report had a healthy PTY but no hooks. OpenCode's own log
rejected the old `opencode-plugin.mjs` target: configured plugin paths must be
directories. V2 also replaced V1's function-returning-hooks API.

Que now detects the OpenCode major version before installing hooks. V1 keeps its
existing server plugin. V2 installs a CLI-only package directory with a `./tui`
export and adds it to `OPENCODE_CLI_CONFIG_CONTENT.plugins`, retaining existing
CLI configuration and plugin entries. No user configuration file is rewritten.

The V2 adapter runs in the terminal, not the shared server. It reads the selected
root session and OpenCode's public cached status, permission, form and message
APIs. Server events schedule a cache read; a 250ms timer also catches local route
changes. Unchanged snapshots do not emit signals. Unloading removes both sources.
Local delivery uses atomic signal files; SSH uses OSC, including tmux passthrough
and the current tmux channel on reattachment.

This adds one synchronous version probe to OpenCode startup because its two APIs
cannot safely share an entrypoint. Other CLI startup paths retain their background
version probe.

The OpenCode external-session toggle now installs an owned discovery package at
`$XDG_CONFIG_HOME/opencode/plugins/que-external-v2` (default `~/.config`). It uses
the CLI entrypoint and an inert server entrypoint, without rewriting user config.
The external wrapper skips Que-owned terminals, reports workspace and external
identity to Que's configured external signal directory, and observes only this
CLI's open root-session tabs. Opening an already idle chat or updating its title
does not generate completion notifications. Turning the toggle off removes the
owned discovery files and an enable marker checked by already loaded instances;
the existing backend ingress filter also rejects disabled OpenCode signals.

Only source review was performed. No app, test, compilation or live CLI run was
performed; validate with a newly launched V2 card after building. Existing OpenCode
processes retain the environment and plugin configuration they started with.

References:
- https://opencode.ai/v2/docs/build/plugins/migrate-v1
- https://opencode.ai/v2/docs/build/plugins/cli/
- https://github.com/anomalyco/opencode/blob/beta/packages/cli/src/config/config.ts
- https://github.com/anomalyco/opencode/blob/beta/packages/plugin/src/tui/context.ts
