"use client";
// The overview: every card at a glance, in three sections one below the other —
// the queue in its order, the cards at work, and those set aside for later —
// each a grid. Cards move between sections as the queue moves them: a card done
// working, or back from later, takes its place in the queue. It is a view of the
// queue, not a mode: opening a card leaves it and opens the card where it lives.
import { useEffect, useLayoutEffect, useRef, type CSSProperties } from "react";
import type { QueueCard } from "@/lib/card-queue";
import { useSessionSnapshot } from "@/lib/session-store";
import { tilePreview } from "@/lib/card-tile";
import { useI18n } from "@/hooks/useI18n";
import { MarkdownMessage } from "./MarkdownMessage";
import { CardMessage } from "./chat/CardMessage";
import { nicknameHue } from "@/lib/card-nickname";

type Section = { key: "queue" | "working" | "later"; label: string; cards: QueueCard[] };

export function CardOverview({ queued, working, later, titleOf, subtitleOf, onOpen, onClose }: {
  queued: QueueCard[];
  working: QueueCard[];
  later: QueueCard[];
  titleOf: (card: QueueCard) => string;
  subtitleOf: (card: QueueCard) => string;
  onOpen: (id: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); onClose(); } };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  const sections: Section[] = [
    { key: "queue", label: t("overview.queue"), cards: queued },
    { key: "working", label: t("overview.working"), cards: working },
    { key: "later", label: t("overview.later"), cards: later },
  ];
  return <div className="cq-overview">
    {sections.map(section => <section key={section.key} className="cq-overview-section" data-section={section.key} aria-label={section.label}>
      <header><span>{section.label}</span><span>{section.cards.length.toString().padStart(2, "0")}</span></header>
      <div className="cq-overview-grid">
        {/* Not a <button>: a face holds the reply's own links and copy buttons. */}
        {section.cards.map(card => <div key={card.id} role="button" tabIndex={0} className="cq-overview-card" data-section={section.key}
          onClick={() => onOpen(card.id)} onKeyDown={event => { if (event.key === "Enter" && event.target === event.currentTarget) onOpen(card.id); }}>
          <CardFace card={card} name={titleOf(card)} subtitle={subtitleOf(card)} />
        </div>)}
      </div>
    </section>)}
  </div>;
}

/** A card's face: its header, the latest of its conversation, and what it is doing now. */
function CardFace({ card, name, subtitle }: { card: QueueCard; name: string; subtitle: string }) {
  const { t } = useI18n();
  const snapshot = useSessionSnapshot(card.harness ? card.id : "");
  const preview = tilePreview(snapshot, card.harness?.replyPreview || "", 600, 4);
  // The summary keeps to its end, where the conversation is.
  const summary = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { const box = summary.current; if (box) box.scrollTop = box.scrollHeight; });
  const status = !card.harness ? t("overview.new")
    : card.phase === "working" ? t("overview.status.working")
    : preview.status === "decision" ? t("overview.decision")
    : card.remindAt !== undefined ? t("queue.稍后提醒")
    : t("overview.waiting");
  return <div className="cq-tile" data-status={preview.status}>
    <div className="cq-card-header">
      <div className="cq-card-identity"><div className="cq-card-heading"><div className="cq-card-title-split">
        <h2>{name}</h2>
        {card.nickname && <span className="cq-card-nickname" style={{ "--cq-nickname-hue": nicknameHue(card.id) } as CSSProperties}>{card.nickname}</span>}
      </div></div>
      <div className="cq-card-state"><i className={card.phase === "working" ? "cq-dot" : "cq-ready-dot"} />{status}<span>{subtitle}</span></div></div>
    </div>
    <div className="cq-harness-body cq-acp"><div ref={summary} className="cq-acp-transcript cq-tile-transcript">
      {preview.ask && (preview.ask.sender
        ? <CardMessage direction="in" peers={[preview.ask.sender]} text={preview.ask.text} />
        : <div className="cq-acp-user-group"><div className="cq-acp-user"><p>{preview.ask.text}</p></div></div>)}
      {preview.items.map((item, i) => item.kind === "message" ? <CardMessage key={i} direction={item.direction} peers={item.peers} all={item.all} text={item.text} />
        : <div key={i} className="cq-tile-reply"><MarkdownMessage content={item.text} role="assistant" /></div>)}
    </div>
      {preview.live && <div className="cq-tile-live" data-kind={preview.live.kind} role="status">
        <span className="cq-tile-live-label">{t(preview.live.kind === "thought" ? "overview.thinking" : preview.live.kind === "tool" ? "overview.tool" : "overview.decision")}</span>
        <span className="cq-tile-live-text">{preview.live.text}</span>
      </div>}
    </div>
  </div>;
}
