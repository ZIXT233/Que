// "Where was I?" for a card that comes back to the user: what they last asked,
// what happened since, and which cards this one has been talking to. Pure data
// from the session snapshot; no model call.
export type RecapTurn = {
  id: string; text: string; state: string; withdrawn?: boolean;
  source?: "event" | "user" | "agent"; sender?: { cardId: string; name: string };
  at?: number; endedAt?: number;
  blocks: { type: string; text?: string; stream?: string }[];
};
export type Recap = {
  goal?: string; lastAsk: string; lastAskAt?: number;
  since: { name: string; count: number }[]; lastReply?: string; peers: string[];
};

const human = (t: RecapTurn) => t.source !== "event" && !t.sender && !t.withdrawn && t.text.trim() !== "";
const replyOf = (t: RecapTurn) => t.blocks.filter(b => b.type === "text_delta" && b.stream !== "thought").map(b => b.text || "").join("").trim();

export function clip(text: string, limit: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > limit ? clean.slice(0, limit - 1) + "…" : clean;
}

/** Null when the transcript is short enough to read directly. */
export function cardRecap(turns: RecapTurn[]): Recap | null {
  const visible = turns.filter(t => !t.withdrawn && t.state !== "queued");
  if (visible.length < 3) return null;
  let index = -1;
  for (let i = visible.length - 1; i >= 0; i--) if (human(visible[i])) { index = i; break; }
  if (index < 0) return null;
  const ask = visible[index];
  const counts = new Map<string, number>();
  for (const turn of visible.slice(index + 1)) {
    const name = turn.sender?.name ?? (turn.source === "event" ? "Que" : "你");
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const first = visible.find(human);
  const lastReply = [...visible].reverse().map(replyOf).find(Boolean);
  const peers = [...new Set(visible.flatMap(t => t.sender ? [t.sender.name] : []))];
  return {
    goal: first && first !== ask ? clip(first.text, 160) : undefined,
    lastAsk: clip(ask.text, 400), lastAskAt: ask.at,
    since: [...counts].map(([name, count]) => ({ name, count })),
    lastReply: lastReply ? clip(lastReply, 400) : undefined, peers,
  };
}

export function timeAgo(at: number | undefined, now = Date.now()): string {
  if (!at) return "";
  const minutes = Math.max(0, Math.floor((now - at) / 60000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)} 小时前`;
  return `${Math.floor(minutes / 1440)} 天前`;
}
