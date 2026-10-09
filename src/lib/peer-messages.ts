// Messages from other cards. One that reaches a busy Agent rides on a QueACP
// tool result (`queacpMessages`); it is drawn after that tool call, on the
// Agent's side, like the messages that arrive as a turn of their own.

export type PeerMessage = { from: { cardId: string; name: string }; text: string; at?: number };

function find(value: unknown, depth: number): PeerMessage[] {
  if (depth > 4 || value == null) return [];
  if (typeof value === "string") {
    if (!value.includes("queacpMessages")) return [];
    try { return find(JSON.parse(value), depth + 1); } catch { return []; }
  }
  if (Array.isArray(value)) return value.flatMap(item => find(item, depth + 1));
  if (typeof value !== "object") return [];
  const object = value as Record<string, unknown>;
  if (Array.isArray(object.queacpMessages)) {
    return object.queacpMessages.filter((m): m is PeerMessage =>
      !!m && typeof m === "object" && typeof (m as PeerMessage).text === "string" && typeof (m as PeerMessage).from?.name === "string");
  }
  // MCP results arrive as `{content: [{type: "text", text}]}`, sometimes nested in ACP content.
  return ["content", "text", "result", "rawOutput"].flatMap(key => find(object[key], depth + 1));
}

/** The messages handed over in one tool call's output. */
export function messagesIn(block: { rawOutput?: unknown; content?: unknown }): PeerMessage[] {
  const found = find(block.rawOutput, 0);
  return found.length ? found : find(block.content, 0);
}

/** Inserts a `peer_message` block (`from`, `text`) after every tool call that handed messages over. */
export function withPeerMessages<T extends { type: string; rawOutput?: unknown; content?: unknown }>(blocks: T[]): T[] {
  return blocks.flatMap(block => block.type === "tool_call"
    ? [block, ...messagesIn(block).map(message => ({ ...message, type: "peer_message" }) as unknown as T)]
    : [block]);
}
