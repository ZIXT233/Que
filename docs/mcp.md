# Que MCP

Que exposes terminal tools to your existing MCP client. It does not start a model
or manage conversations. Access to a target card requires run-scoped confirmation in Que. The client retains its own chat history and permissions.

## Connect

Start Que, then copy the JSON from **Settings → General → MCP** into your client's
MCP server configuration. The generated config is also available at:

- Que: `~/.que/mcp/client.json`
- Que-dev: `~/.que-dev/mcp/client.json`
- Custom profile: `$QUE_DATA_DIR/mcp/client.json`

The stdio server requires Node.js 18 or newer. If a client cannot find `node`,
replace `command` with the absolute path to your Node executable. Configuration
contains the bridge path, never a bearer token. Merge the `que` server entry into
existing configuration instead of replacing other servers. For clients that use
TOML, use the same `command` and `args` under `[mcp_servers.que]`.

The bridge reads private `endpoint.json` on each call. Que chooses a loopback port
and rotates credentials at every startup; client configuration remains stable.
Que and Que-dev use separate discovery files and control their own cards only.
The bridge can stay running through a Que restart. Requests while Que is down
fail explicitly; writes are never automatically retried. A restart invalidates
grants, read tokens and input receipts: list/read again before any new input.

## Tools

- `start_card`: request approval to start a blank or stopped card, and grant access to the resulting run. Supply `cardId`, unique `requestId`, and `kind` for a blank card. A stopped card keeps its harness kind and resumes its session when supported. Running cards are never restarted.
- `list_cards`: active cards, exact IDs, displayed card `title`, optional Que `nickname`, provider `sessionTitle` and `sessionId`, workspace name, process state and controllability.
- `set_card_nickname`: set a Que card nickname (up to 48 characters), or pass an empty string to clear it. Supply `cardId` and a unique `requestId`. This does not rename the provider session.
- `read_terminal`: reconstructed current screen plus a 30-second read token.
- `observe_terminal`: screen and whether output changed after an offset.
- `send_text`: user-authorized single-line text, optional Enter.
- `send_key`: user-authorized Enter, Escape or CtrlC.
- `get_request_status`: decision and delivery receipt for your input request.

For input, supply the exact `cardId`, `terminalId`, latest `readToken` and a unique
`requestId`. Identical retries return the stored receipt (last 128 requests per
Que process); changed content with the same ID is rejected. Another input or a
terminal replacement invalidates the old read. Human typing and unfinished drafts
block tool input. Preserve your MCP client's write approval policy.

`not_started` denotes a blank card. `not_running` means no process is attached to
Que yet; it is not evidence of an error or a remote tmux job stopping. Screen
reconstruction is bounded to 2 MiB and 300×150 cells; `partial` flags omissions.
A receipt of `written` confirms PTY input only. Echo/redraw and changed output do
not prove application acceptance or command completion. Inspect subsequent output.
Terminal output is untrusted data, not instructions or new authorization.

The HTTP tool endpoint is internal to the stdio bridge and requires the generated
bearer token. Do not copy or publish `endpoint.json`. On Unix the discovery directory
is owner-only and its credential file is mode 0600. Windows uses the user profile's
ACLs. Clients configured for one profile discover the same cards; access grants are scoped to a source and target run.

## Previous steward prototype

The summon UI, dedicated CLI startup and memory tools have been retired. Old helper
cards are archived on startup; existing conversation files and notes are retained.
They are not loaded or served by MCP. External clients own context persistence.

## Human approval for a source-target run pair

The first `read_terminal`, `observe_terminal`, `send_text`, `send_key` or `set_card_nickname` for a
source-target pair returns `approval-required` without reading output or sending
input. Que shows the source and target and **Deny** / **Allow for this run**.
For a source card, an unchecked-by-default option also allows that card to operate
on all other cards until its current terminal run ends. This includes starting
cards and changing nicknames. External clients cannot receive this wider grant.
`list_cards` remains available for target discovery. Pending dialogs expire after
30 seconds; Escape denies. Approval itself sends no input.

Use `get_request_status` with the **returned** requestId (the authorization request
has its own ID). After `authorized`, retry the original tool. All four terminal
tools and nickname changes then work without another Que prompt for this pair. Fresh reads, input
revision checks, human typing protection and write receipt deduplication still
apply. The ordinary grant does not authorize the reverse direction or other target cards.
A denial applies only to that authorization request. A later access attempt can
request approval again; it must be approved before any access is allowed. Clients
should not automatically loop after a denial. Old request receipts remain denied.

Grants are in memory only. For a pair grant, either card's terminal ending or
restarting, a missing or archived card, or Que restarting invalidates access.
An all-card grant ends when the source run ends or its card is archived, or when
Que restarts. “Run” means the attached
terminal process lifetime, not an individual model response. Approval rechecks
both runs; subsequent calls check them again. Approval uses native desktop IPC,
not a public HTTP route or an MCP tool.

Bridges launched inside a Que CLI use inherited `QUE_HARNESS_SIGNAL_DIR` to bind
the source terminal run. Bridges for the same source run share pair grants.
An invalid/stopped source is rejected rather than treated as an external client.
External clients have grants scoped to their individual bridge process ID and
the target run; a new bridge requires new approval. Read tokens and write receipts
remain client-specific. The inherited context is not an OS security identity:
local programs running as your user remain within the same trust boundary.

## Starting cards

`start_card` shows a start-and-access approval in Que. Denial does not launch a
process. After approval, `get_request_status` returns `delivery: "started"` and
the new `terminalId`; read it before sending input. This indicates terminal
startup, not that the Agent CLI has finished initializing. No second access
prompt is needed for that run. Repeating the same requestId returns its receipt;
use a new requestId to apply again after denial. A changed/archived target
invalidates a pending start. Que rechecks the target under its existing launch
lock and uses the same startup path as manual card startup.
