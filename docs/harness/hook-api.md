# Harness hook API

**English** | [简体中文](hook-api.zh-CN.md)

Que learns what a CLI harness is doing from the lifecycle hooks those CLIs already
offer. This is the shared contract: what a harness reports, how the report reaches
Que, and what Que derives from it. `src-tauri/resources/bin/harness-hook.cjs` points here.

The authoritative implementation is `src-tauri/src/harness/signals.rs`;
`src-tauri/protocol-ref/harness/` carries a TypeScript mirror kept as a reference.
Everything below describes behaviour that both sides are expected to agree on.

## 1. Ingress

Three files report for every supported harness. All three are **observation only**:
they never block the CLI, change its input, or write model-visible text. The one
exception is Cursor, which requires a JSON verdict on stdout (see §2.3).

| Entry point | Used by | Delivered as |
| --- | --- | --- |
| `src-tauri/resources/bin/harness-hook.cjs` | `cursor`, `codex`, `antigravity`, `gemini`, `grok`, `claude`, `codebuddy`, `devin` | command hook, stdin JSON |
| `src-tauri/resources/bin/harness-opencode.mjs` | `opencode` | plugin callback |
| `src-tauri/resources/bin/harness-pi.mjs` | `pi`, `omp` | extension callback |

### 1.1 Environment

| Variable | Set by | Meaning |
| --- | --- | --- |
| `QUE_HARNESS_KIND` | launcher / ingress | Harness id. Inferred from the plugin path (`…/harness-plugins/<kind>/`) or from the event name (Cursor) when absent. |
| `QUE_HARNESS_CHANNEL` | launcher | Token for the OSC channel. Present only for sessions Que launched. |
| `QUE_HARNESS_SIGNAL_DIR` | launcher | File sink for this card. Present only for sessions Que launched. |
| `QUE_HARNESS_TTY` | launcher | TTY the OSC frame is written to. Defaults to `/dev/tty`; SSH sessions export `$(tty)`. |
| `QUE_HARNESS_WATCHDOG_MS` | launcher | Ingress self-kill deadline. Defaults to 8000; the launcher injects `(hook timeout − 2s)`, floored at 1s, so a hung stdin still delivers the signal instead of dying to the CLI's own "hook timed out". |
| `QUE_HARNESS_SESSION_ID` | launcher | Session being resumed, so a plugin can bind to it before the first event. |
| `QUE_HARNESS_DEBUG` | launcher | `1` writes `hook-trace.jsonl` and `last-stop-diagnostic.json` into the sink. |
| `QUE_EXTERNAL_SIGNAL_DIR` | user | Overrides the external sink location. |

The ingress exits silently when none of `QUE_HARNESS_SIGNAL_DIR`, `QUE_HARNESS_CHANNEL`,
a legacy `active.json`, or a known `QUE_HARNESS_KIND` is present. Known kinds:
`cursor`, `codex`, `antigravity`, `gemini`, `grok`, `claude`, `opencode`, `codebuddy`,
`pi`, `omp`, `devin`.

### 1.2 Payload

The ingress reads a superset of every harness's field names and emits one shape
(`HookSignal`, camelCase JSON):

| Field | Notes |
| --- | --- |
| `kind` | Harness id. |
| `at` | Epoch ms. Written by the ingress; the OSC path is re-stamped at ingest. |
| `event` | The harness's own event name, passed through as-is — see §3. |
| `sessionId` | From `conversationId` / `conversation_id` / `session_id` / `sessionId`. Validated as `^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$` before it is trusted. |
| `agentId` | Subagent id. Any signal carrying one is **dropped** by the state machine: subagents are not cards. |
| `tool` | From `toolCall.name` / `tool_name` / `toolName` / `name`. |
| `prompt` | Only on submit-shaped events. |
| `firstPrompt`, `title` | Session naming hints. |
| `turns` | Optional conversation snapshot from an extension: chronological `{ role: "user" | "assistant", text: string }[]`. External notices display both sides from it. |
| `replyPreview` | Turn-end reply clip. Cards get 160 chars; the external sink keeps up to 2000. |
| `notification` | From `notification_type` / `notificationType` / `type`. |
| `fullyIdle` | Antigravity only: whether a `Stop` really ended the turn. A fact the contract has no event name for, reported as a field instead of by renaming an event. |
| `workspaceRoot` | External sessions only, so a cold start can still name the card. |
| `external` | Set by the ingress when the emitting process carried no Que channel. |

## 2. Delivery

### 2.1 OSC

```
ESC ] 777 ; que ; <base64 of {"token":…,"signal":{…}}> BEL
```

Written to `QUE_HARNESS_TTY`. `src-tauri/src/harness/osc.rs` reassembles frames across
PTY chunk boundaries, requires the token to match the terminal it was launched for, and
re-stamps `at` with the ingest clock — a hook process's own clock is not trusted.

This is the path that gives a card sub-second latency; the file sink is the fallback for
harnesses whose hook runner cannot write to a TTY.

### 2.2 File sinks

Both sinks take one file per event, written as `<at>-<uuid>.json` via a `.tmp` + rename
pair with mode `0600`; a consumer deletes the file once read.

| Sink | Directory | Owner |
| --- | --- | --- |
| Card | `<data>/harness-signals/<terminal_id>/` | `paths.rs::signal_dir`; pre-created by the launcher |
| External | `<data>/external-signals/` | `paths.rs::external_signal_dir`; the ingress creates it and prunes files older than 5 minutes |

`<data>` is `QUE_DATA_DIR` or `~/.que`.

External signals are the ones emitted by sessions **Que never launched** — Cursor's
user-level `hooks.json` is global, so IDE chats and ordinary terminals report there too.
They become transient notices rather than queue cards, and each kind can be switched off
individually in settings.

### 2.3 Cursor's reply

Cursor hooks block on a verdict, so the ingress always answers: `{"continue":true}` for
`beforeSubmitPrompt`, `{"permission":"allow"}` for `preToolUse` / `beforeShellExecution` /
`beforeMCPExecution`, `{}` otherwise. Que never gates a session it is only watching —
which is exactly why those three events cannot be read as "the user is being asked"; see §4.4.

## 3. From an event to a conclusion

Harnesses name the same boundary differently. A harness's own words are read in exactly
one place — the shared vocabulary in `signals.rs` (`default_meaning`), reached through
each harness's `meaning` in the registry — and turn straight into what the card does with
them. There is deliberately no vocabulary of "canonical events" in between: such a layer
only produced a name that had to be translated again, and it invited filing an event
under a meaning it does not have.

The states themselves are two. What this vocabulary adds is everything else the signal
path needs to know: where a turn begins and ends, and the honest "cannot tell" of a gate
the CLI answers itself.

| Meaning | Events | Card |
| --- | --- | --- |
| `SessionStart` | `SessionStart`, `sessionStart` | a card still `starting` flips to `attention` (§4) |
| `TurnStart` | `beforeSubmitPrompt`, `UserPromptSubmit`, `BeforeAgent`, `PreInvocation` | `working` |
| `Working` | `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `BeforeTool`, `AfterTool`, `PostInvocation`, `preToolUse`, `postToolUse`, `postToolUseFailure` | `working` |
| `MaybeAttention` | Antigravity's `PreToolUse`; Cursor's `preToolUse`, `beforeShellExecution`, `beforeMCPExecution` | `working` now, `attention` if the window runs out (§4.4) |
| `Attention` | `PermissionRequest`; `Notification` with `permission_prompt` / `ToolPermission` / `idle_prompt`; an ask-shaped tool's tool start | `attention` |
| `TurnEnd` | `stop`, `Stop`, `StopFailure`, `StopCancelled`, `sessionEnd`, `AfterAgent`, `afterAgentResponse` | `attention` |
| `Nothing` | anything else, and every subagent event | unchanged |

Two rules are applied before the table:

- An ask-shaped tool (`request_user_input`, `ask_user_question`, `ask_user`,
  `ask_question`, `AskUserQuestion`) *is* the ask: it fires for one call only, so whatever
  gate the harness owns has nothing to do with it.
- A `Stop` whose `fullyIdle` is `false` is Antigravity pausing mid-turn, so it reads as
  `Working` rather than `TurnEnd` (§1.2).

The ingress maps names, never meaning: a harness's vocabulary is passed through, and a
fact the contract has no event name for travels as a field (`fullyIdle`, §1.2) instead of
by renaming an event into another. So a name means the same thing for every harness —
`PermissionRequest` is always "a prompt is already on screen", Antigravity included.

## 4. State machine

`hook_state` turns a meaning into a state, and that is the entire mapping:

| Meaning | Card |
| --- | --- |
| `Working`, `TurnStart`, `MaybeAttention` | `working` |
| `Attention`, `TurnEnd` | `attention` |
| `Nothing`, `SessionStart` | no change |

`SessionStart` while the card is still `starting` is the one case outside that table: it
promotes to `attention`.

### 4.1 Attention, stated

These are the CLI telling Que a prompt is on screen. They take effect immediately:

- `Notification(permission_prompt)`, `Notification(ToolPermission)`, `Notification(idle_prompt)`
- `PermissionRequest` — the harness reports the gate itself
- `Stop` / `sessionEnd` / `AfterAgent` — the turn ended, so the user is the next actor.
  Antigravity's paused `Stop` is excluded, see §3.
- an ask-shaped tool's own tool-start event

### 4.2 Attention, observed

Not every wait comes through the hook protocol. Two probes watch the byte stream instead:

- **Kitty notifications** (`OSC 99`, and the legacy `OSC 777;notify` / iTerm `OSC 9`) —
  Cursor announces "Cursor is waiting for you" this way. This is Cursor's real ask signal.
  Any notification sets `attention` with the body as the preview.
- **Title / action-required probe** — Codex's TUI title and an `OSC 9` "action required"
  line. Both are read as the CLI's own report.

`observe_title` and `observe_notify` are last-writer-wins: a title spinner never overwrites
a newer hook, but a missed hook can never leave a card stuck either.

### 4.3 Working

`UserPromptSubmit` — a prompt was submitted, or a tool is running. A `working` state clears
`replyPreview` and resets any held guess.

### 4.4 Held asks

Antigravity and Cursor fire the **same tool hook whether or not the user is asked**: the
hook runs before their gate, and nothing in the payload says which way it went. Reading
those events as `attention` raises a card, reorders the queue and fires a notification on
every file read and every `grep` — alert fatigue by construction.

So they are treated as a guess:

- `guesses_attention` matches Antigravity's `PreToolUse` and Cursor's `preToolUse` /
  `beforeShellExecution` / `beforeMCPExecution`.
- Such a signal sets `state = working` and stamps `held_attention_at` (first guess wins;
  later ones do not move the deadline) and `held_tool`.
- A tool that runs on its own reports back within milliseconds, so its follow-up
  (`PostToolUse`, a title, a notification, a turn end) clears the hold and nothing is ever
  shown.
- A tool that is really waiting stays silent. `HELD_ATTENTION_MS` (5s) later the hold is
  **promoted** to `attention`.

Promotion needs two conditions: the window has elapsed **and** the card is still `working`.
The second one matters: if the CLI already said something definite (a notification, a
title, a turn end), there is no guess left to promote, and raising it again would undo
whatever the user just did with the card.

Nothing arrives to do the promotion, so it is ticked:

| Path | Tick | Function |
| --- | --- | --- |
| Card + OSC | 250ms | `mod.rs::promote_held` |
| External sessions | 500ms | `external.rs::promote_held_asks` |
| Reference implementation | per snapshot | `settleHeld` in `runtime.ts` |

The external path replays the promoted ask through the normal ingress, so the notice is
built exactly like any other one.

**Known cost.** A single tool call that outlives the window raises one late ask that the
tool's own completion then retracts. 5s is chosen to sit above the round-trip of an
auto-allowed tool (tens to hundreds of ms) and below a human's patience; lowering it
trades more late asks for faster real ones. Filtering genuinely read-only tools out of the
guess entirely is the next step if that trade ever needs to move.

## 5. Harness capability matrix

| Kind | Hook events registered | Real ask source | Guessed (held) |
| --- | --- | --- | --- |
| `claude`, `codebuddy` | `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `Notification`, `PostToolUse`, `PostToolUseFailure`, `Stop`, `StopFailure` | `PermissionRequest`, `Notification(permission_prompt)` | — |
| `codex` | `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `Stop` | `PermissionRequest`, OSC 9 action-required | — |
| `cursor` | `sessionStart`, `beforeSubmitPrompt`, `preToolUse`, `postToolUse`, `postToolUseFailure`, `beforeShellExecution`, `beforeMCPExecution`, `afterAgentResponse`, `stop`, `sessionEnd` | OSC 99 notification, `stop` | `preToolUse`, `beforeShellExecution`, `beforeMCPExecution` |
| `antigravity` | `PreInvocation`, `PostInvocation`, `PreToolUse`, `PostToolUse`, `Stop` | none (no permission event exists) | `PreToolUse` |
| `gemini` | `SessionStart`, `BeforeAgent`, `AfterAgent`, `BeforeTool`, `AfterTool`, `Notification` | `Notification` | — |
| `grok` | `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Stop`, `StopFailure`, `StopCancelled`, `Notification` | `Notification` | — |
| `opencode` | plugin: `session.*`, `permission.asked`, `question.asked`, `permission.replied`, `session.idle` | `permission.asked`, `question.asked` | — |
| `pi`, `omp` | extension: `session_start`, `before_agent_start`, `agent_start`, `agent_end` / `agent_settled`, `ui_prompt_start`, `ui_prompt_end` | `ui_prompt_start` | — |
| `devin` | `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `Stop`, `SessionEnd`, `PostCompaction` | — | `PermissionRequest` |
| `shell` | none — the PTY byte stream is probed instead | command finished | — |

Subagent events (`agentId` present) are dropped for every kind.

## 6. Debugging

With `QUE_HARNESS_DEBUG=1` the ingress appends `hook-trace.jsonl` (event, session id, and
which delivery legs succeeded) and, for Codex `Stop`, `last-stop-diagnostic.json`
(`replyFieldPresent`, `replyLength`, `previewLength` — field metadata only, never text).

On the Rust side every ingested signal is recorded per terminal with its `source`:
`hook` / `file` / `osc` / `notify-osc` / `title` / `probe`. A hold that promotes logs its
own `HeldAsk` event with how long it was held and which tool it named, so a late ask can
be told apart from a real one after the fact. The same log is surfaced through
`HarnessDebugSnapshot`.

## 7. Attribution

Event mapping follows Orca's Codex adapter (MIT), as noted in the mirror's source.

## 8. File map

Every harness owns one file, `src-tauri/src/harness/kinds/<kind>.rs`, implementing the
`Harness` trait declared in `registry.rs`. The registry (`ALL`, `find`) is the single
dispatch point: launch, hook install, session access, event vocabulary and per-kind
quirks are all read from it, and the settings-key aliasing (`gemini` → `antigravity`,
`omp` → `pi`) lives there as `ingress_key`. Adding a harness means adding one file and
one row in `ALL` (plus a frontend entry in `src/lib/harness/catalog.ts`).

| Concern | File |
| --- | --- |
| Registry: `Harness` trait, dispatch, aliasing | `src-tauri/src/harness/registry.rs` |
| One harness (launch, install, store, quirks) | `src-tauri/src/harness/kinds/<kind>.rs` |
| State machine, shared vocabulary, hold/settle | `src-tauri/src/harness/signals.rs` |
| OSC frame decoding | `src-tauri/src/harness/osc.rs` |
| Card indicators (title, notifications) | `src-tauri/src/harness/notify_osc.rs`, `kinds/codex.rs` |
| External sessions and notices | `src-tauri/src/harness/external.rs` |
| Card ingestion, promotion tick | `src-tauri/src/harness/mod.rs` |
| Install mechanics (files, SSH, command, env) | `src-tauri/src/harness/install.rs` |
| Session-access guards and fallbacks | `src-tauri/src/harness/session_label.rs` |
| Entry points: prepare / realign / external deploy | `src-tauri/src/harness/hooks.rs` |
| Frontend registry (picker, external toggles, quirks) | `src/lib/harness/catalog.ts` |
| Ingress | `src-tauri/resources/bin/harness-hook.cjs`, `src-tauri/resources/bin/harness-opencode.mjs`, `src-tauri/resources/bin/harness-pi.mjs` |
| TypeScript mirror | `src-tauri/protocol-ref/harness/` |
