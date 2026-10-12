// What a card's tile shows: where its conversation stands, as the last few
// things in its latest turn, in the order they happened.
import type { SessionSnapshot } from "./session-store";

type Peer = { cardId: string; name: string };
export type TileItem =
  | { kind: "text"; text: string }
  /** A message to or from another card, inside the turn. */
  | { kind: "message"; direction: "in" | "out"; peers: Peer[]; all?: boolean; text: string }
  /** The tool the Agent is running right now. */
  | { kind: "activity"; title: string };

export type TilePreview = {
  /** `decision`: a permission or form waits for the user. */
  status: "decision" | "working" | "waiting" | "idle";
  /** What waits for the user's decision, when status is `decision`. */
  decision?: string;
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
  const tool = running ? [...last.blocks].reverse().find(block => block.type === "tool_call" && ["pending", "in_progress"].includes(block.status ?? "")) : undefined;
  if (tool?.title) items.push({ kind: "activity", title: tool.title });
  const decision = last.blocks.find(block => block.type === "decision" && block.state === "pending");
  const recent = items.filter(item => item.kind !== "text" || item.text.trim()).slice(-shown)
    .map((item, i, all): TileItem => item.kind === "activity" ? item : { ...item, text: tail(item.text, i === all.length - 1 ? limit : limit / 2) });
  return {
    status: decision ? "decision" : running ? "working" : "waiting",
    ...(decision ? { decision: decision.request?.toolCall?.title } : {}),
    ...(last.text.trim() && last.source !== "event" ? { ask: { text: tail(last.text, 160), sender: last.sender } } : {}),
    items: recent,
  };
}
