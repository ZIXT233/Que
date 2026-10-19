# QueACP MCP

QueACP MCP lets an agent — another card, or your own MCP client — read and talk to QueACP's cards. Every session it reaches is still an ordinary card in the queue that you can operate directly.

## Connect

Cards started by QueACP get the server automatically. For your own MCP client, copy the JSON from **Settings → General → MCP**; the generated config is also written to `client.json` in the data directory (`~/.queacp/mcp`, development builds `~/.queacp-dev/mcp`, or `$QUEACP_DATA_DIR/mcp`).

The stdio bridge needs Node.js. It reads the private `endpoint.json` on each call, so QueACP can rotate its port and credentials at every start without changing your configuration. While QueACP is not running, calls fail explicitly; nothing is retried automatically.

## Access

- Cards talk over **channels** the user opens between two cards (see [agent-interaction.md](agent-interaction.md)). With one, both may message and read each other. A message to a card without one waits until the user allows it. A card the user gave **all channels** is joined to every card; your own MCP client, holding the private token, counts as you.
- Beyond that, a card has only the **permissions** the user turns on in its header, all off by default: **manage cards** (create and archive cards, stop another card's turn, rename any card), **all channels**, and **settings** (settings, workspaces, remote hosts). Without manage cards, a card may rename only itself, and `create_card` asks the user instead: it returns `waitingForUser`, and the answer comes as a message. A new card is joined to the card that made it.
- Decisions inside a session (permission and form requests) belong to the user. No tool answers them, and no message can.

## Tools

Sessions — a card is one Agent session, addressed by its `cardId` from `list_cards`. How messages travel is in [agent-interaction.md](agent-interaction.md).

- `list_cards()` — cards with their name, workspace, Agent and state.
- `read_session(cardId, limit?, turnId?, detail?)` — compact by default: state, pending decisions, and the last few turns as message plus final-reply excerpts. `turnId` returns that one turn in full; `detail: "full"` returns everything.
- `send_message(to, requestId, text)` — puts a message, signed with your card, in the inbox of each card in `to`: a cardId, a list of them, or `"all"` for every other card with an Agent. A stopped card is connected. Nothing comes back by itself: an answer is a message from the target. Reuse `requestId` only to retry the same message. Repeats and floods are refused.
- `wait_messages(timeoutSeconds?)` — waits up to 50 s (at most 120 s) for messages to your card and returns them. Messages also ride on any QueACP tool result as `queacpMessages`, or start your next turn when you are idle; each is handed over once.
- `cancel_turn(cardId, turnId)` — cancels a running turn or withdraws a queued message (another card's: needs manage cards); read the session to confirm.
- `set_card_nickname(cardId, nickname, requestId)`.

Cards and workspaces: `list_workspaces` and `list_harnesses` for anyone; `create_card` for anyone (asks the user unless the card may manage cards); `archive_card` with manage cards.

Settings: `list_settings` for anyone; `read_settings`, `update_settings`, `create_workspace`, `list_remote_hosts` and `configure_remote_host` with the settings permission. Credentials and environment values are never returned.
