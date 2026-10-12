import { MarkdownMessage } from "../MarkdownMessage";
import { useCardName } from "@/lib/card-names";

type Peer = { cardId: string; name: string };

/**
 * A message between cards. Agents wrote it, so it sits on the Agent's side; its
 * color says which way it went: blue received, green sent. How it was delivered
 * (a turn of its own, a tool result) does not matter.
 */
export function CardMessage({ direction, peers, all, text }: { direction: "in" | "out"; peers: Peer[]; all?: boolean; text: string }) {
  // The name the card has now; the one saved with the message once it is gone.
  const nameOf = useCardName();
  const names = all ? "全部" : peers.map(p => (p.cardId && nameOf(p.cardId)) || p.name).join("、");
  return <div className={`cq-acp-msg cq-acp-msg--${direction}`}><small className="cq-acp-msg-label">{direction === "in" ? `来自 ${names}` : `发给 ${names}`}</small><MarkdownMessage content={text} role="assistant"/></div>;
}
