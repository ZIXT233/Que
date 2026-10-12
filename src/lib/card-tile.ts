// What a card's tile shows: where its conversation stands, in a few lines.
import type { SessionSnapshot } from "./session-store";

export type TilePreview = {
  /** `decision`: a permission or form waits for the user. */
  status: "decision" | "working" | "waiting" | "idle";
  /** The tool the Agent is running right now, if any. */
  activity?: string;
  /** The end of the latest reply: conclusions come last. */
  text: string;
  /** What the latest turn answers: the user's words, or another card's message. */
  ask?: { text: string; sender?: { cardId: string; name: string } };
};

const tail = (text: string, limit: number) => {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  const cut = trimmed.slice(-limit);
  const line = cut.indexOf("\n");
  return "…" + (line >= 0 && line < limit / 3 ? cut.slice(line + 1) : cut);
};

export function tilePreview(snapshot: SessionSnapshot | undefined, fallback = "", limit = 320): TilePreview {
  const turns = (snapshot?.turns ?? []).filter(turn => !turn.withdrawn && turn.state !== "queued");
  const last = turns.at(-1);
  if (!last) return { status: "idle", text: tail(fallback, limit) };
  const running = ["running", "cancelling"].includes(last.state);
  const reply = last.blocks.filter(block => block.type === "text_delta" && block.stream !== "thought").map(block => block.text ?? "").join("");
  const decision = last.blocks.find(block => block.type === "decision" && block.state === "pending");
  const tool = running ? [...last.blocks].reverse().find(block => block.type === "tool_call" && ["pending", "in_progress"].includes(block.status ?? "")) : undefined;
  return {
    status: decision ? "decision" : running ? "working" : "waiting",
    activity: decision?.request?.toolCall?.title ?? tool?.title,
    text: tail(reply, limit),
    ...(last.text.trim() && last.source !== "event" ? { ask: { text: tail(last.text, 160), sender: last.sender } } : {}),
  };
}
