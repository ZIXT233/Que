// What a card's tile shows: where its conversation stands, as the last few
// things in its latest turn, in the order they happened.
import type { SessionSnapshot, SessionBlock } from "./session-store";
type SessionTurnBlocks = SessionBlock[];

type Peer = { cardId: string; name: string };
export type TileItem =
  | { kind: "text"; text: string }
  /** A message to or from another card, inside the turn. */
  | { kind: "message"; direction: "in" | "out"; peers: Peer[]; all?: boolean; text: string };

export type TilePreview = {
  /** `decision`: a permission or form waits for the user. */
  status: "decision" | "working" | "waiting" | "idle";
  /** One line of what the Agent is doing this moment, while the turn runs. */
  live?: { kind: "thought" | "tool" | "decision"; text: string };
  /** What the latest turn answers: the user's words, or another card's message. */
  ask?: { text: string; sender?: Peer };
  items: TileItem[];
};

const tail = (text: string, limit: number) => {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  const cut = trimmed.slice(-limit);
  const line = cut.indexOf("\n");
  return "…" + (line >= 0 && line < limit / 3 ? cut.slice(line + 1) : cut);
};

/** What the Agent does now: the decision it waits on, the tool it runs, or the end of its thinking. */
function liveLine(blocks: SessionTurnBlocks, decision: SessionTurnBlocks[number] | undefined): TilePreview["live"] {
  if (decision) return { kind: "decision", text: decision.request?.toolCall?.title ?? "" };
  const tool = [...blocks].reverse().find(block => block.type === "tool_call" && ["pending", "in_progress"].includes(block.status ?? ""));
  if (tool?.title) return { kind: "tool", text: tool.title };
  const last = blocks.at(-1);
  if (last?.type === "text_delta" && last.stream === "thought") {
    const line = (last.text ?? "").trim().split("\n").filter(Boolean).at(-1) ?? "";
    return { kind: "thought", text: line.length > 140 ? "…" + line.slice(-140) : line };
  }
  return undefined;
}

export function tilePreview(snapshot: SessionSnapshot | undefined, fallback = "", limit = 320, shown = 3): TilePreview {
  const turns = (snapshot?.turns ?? []).filter(turn => !turn.withdrawn && turn.state !== "queued");
  const last = turns.at(-1);
  if (!last) return { status: "idle", items: fallback.trim() ? [{ kind: "text", text: tail(fallback, limit) }] : [] };
  const running = ["running", "cancelling"].includes(last.state);
  const items: TileItem[] = [];
  for (const block of last.blocks) {
    const previous = items.at(-1);
    if (block.type === "text_delta" && block.stream !== "thought") {
      if (previous?.kind === "text") previous.text += block.text ?? ""; else items.push({ kind: "text", text: block.text ?? "" });
    } else if (block.type === "message") {
      const out = block.direction === "out";
      items.push({ kind: "message", direction: out ? "out" : "in", peers: out ? block.to ?? [] : block.from ? [block.from] : [], all: block.all, text: block.text ?? "" });
    }
  }
  const decision = last.blocks.find(block => block.type === "decision" && block.state === "pending");
  const recent = items.filter(item => item.kind !== "text" || item.text.trim()).slice(-shown)
    .map((item, i, all): TileItem => ({ ...item, text: tail(item.text, i === all.length - 1 ? limit : limit / 2) }));
  return {
    status: decision ? "decision" : running ? "working" : "waiting",
    ...(running ? { live: liveLine(last.blocks, decision) } : {}),
    ...(last.text.trim() && last.source !== "event" ? { ask: { text: tail(last.text, 160), sender: last.sender } } : {}),
    items: recent,
  };
}
