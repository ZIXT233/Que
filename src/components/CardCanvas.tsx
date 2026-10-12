"use client";
// Tile mode: every card on one canvas. The canvas has a single layout, with each
// cell the size of a full card; the overview is that canvas scaled down to fit.
// Opening a card zooms the whole canvas in, so its neighbours stay in place
// around it, edges in view; dragging the canvas moves to them. Only large things
// are ever scaled down, so the open card is drawn at its own size, sharp.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { QueueCard } from "@/lib/card-queue";
import { useSessionSnapshot } from "@/lib/session-store";
import { tilePreview } from "@/lib/card-tile";
import { useI18n } from "@/hooks/useI18n";
import { Icon } from "./QueueIcon";
import { MarkdownMessage } from "./MarkdownMessage";
import { nicknameHue } from "@/lib/card-nickname";
import "./chat/composer.css";

// The overview leaves room above for the toolbar.
const PEEK_X = 76, PEEK_Y = 52, GAP = 40, PAD = 28, TOP = 56;
type Camera = { scale: number; x: number; y: number };

export function CardCanvas({ cards, focused, onFocus, renderCard, titleOf, subtitleOf, needsYou, toolbar }: {
  cards: QueueCard[];
  /** The open card, or null for the overview. */
  focused: string | null;
  onFocus: (id: string | null) => void;
  renderCard: (card: QueueCard) => ReactNode;
  /** The card header's title; the nickname shows beside it, as on the card. */
  titleOf: (card: QueueCard) => string;
  subtitleOf: (card: QueueCard) => string;
  needsYou: (card: QueueCard) => boolean;
  toolbar: ReactNode;
}) {
  const { t } = useI18n();
  const viewport = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const node = viewport.current;
    if (!node) return;
    const measure = () => setSize({ width: node.clientWidth, height: node.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // One layout for both zoom levels: cells as big as a full card.
  const cell = { width: Math.max(420, size.width - 2 * PEEK_X), height: Math.max(360, size.height - 2 * PEEK_Y) };
  const columns = Math.max(1, Math.ceil(Math.sqrt(cards.length)));
  const rows = Math.max(1, Math.ceil(cards.length / columns));
  const world = { width: columns * cell.width + (columns - 1) * GAP, height: rows * cell.height + (rows - 1) * GAP };
  const overviewScale = Math.min(0.5, (size.width - 2 * PAD) / world.width, (size.height - TOP - PAD) / world.height);
  const place = (index: number) => ({ left: (index % columns) * (cell.width + GAP), top: Math.floor(index / columns) * (cell.height + GAP) });
  const index = cards.findIndex(card => card.id === focused);
  const camera = useMemo<Camera>(() => {
    if (index < 0) return { scale: overviewScale, x: (size.width - world.width * overviewScale) / 2, y: TOP + (size.height - TOP - PAD - world.height * overviewScale) / 2 };
    const { left, top } = place(index);
    return { scale: 1, x: (size.width - cell.width) / 2 - left, y: (size.height - cell.height) / 2 - top };
  }, [index, overviewScale, size.width, size.height, world.width, world.height, cell.width, cell.height, columns]);

  // The open card becomes interactive once the zoom has arrived.
  const [arrived, setArrived] = useState<string | null>(null);
  useEffect(() => {
    if (!focused) { setArrived(null); return; }
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { setArrived(focused); return; }
    const timer = setTimeout(() => setArrived(focused), 340);
    return () => clearTimeout(timer);
  }, [focused]);

  // Dragging pans the zoomed canvas; letting go settles on the nearest card.
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const start = useRef<{ pointer: number; x: number; y: number } | null>(null);
  // A drag ends in a click on whatever is under the pointer; that click is not a choice.
  const dragged = useRef(false);
  const nearest = (x: number, y: number) => {
    let best = -1, distance = Infinity;
    cards.forEach((_, i) => {
      const { left, top } = place(i);
      const d = Math.hypot(left + cell.width / 2 + camera.x + x - size.width / 2, top + cell.height / 2 + camera.y + y - size.height / 2);
      if (d < distance) { distance = d; best = i; }
    });
    return cards[best]?.id ?? null;
  };
  const step = (dx: number, dy: number) => {
    if (index < 0) return;
    const column = index % columns + dx, row = Math.floor(index / columns) + dy;
    const next = row * columns + column;
    if (column >= 0 && column < columns && row >= 0 && cards[next]) onFocus(cards[next].id);
  };
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (!focused || event.defaultPrevented) return;
      // Keys typed into the card, or into a dialog over it, stay there.
      const target = event.target;
      if (target instanceof Element && target.closest("input, textarea, select, [contenteditable], [role='dialog'], dialog")) return;
      if (event.key === "Escape") { event.preventDefault(); onFocus(null); }
      else if (event.altKey && event.key.startsWith("Arrow")) {
        event.preventDefault();
        step(event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0, event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });

  const shown = drag ? { ...camera, x: camera.x + drag.x, y: camera.y + drag.y } : camera;
  return <div ref={viewport} className="cq-canvas" data-zoomed={focused ? true : undefined}
    style={{ "--cq-canvas-ink": `${1 / overviewScale}` } as CSSProperties}
    onPointerDown={event => {
      // Pan only from outside the open card: inside it, pointers belong to the card.
      if (!focused || event.button !== 0 || (event.target as HTMLElement).closest(".cq-canvas-cell[data-open]")) return;
      start.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY };
    }}
    onPointerMove={event => {
      const from = start.current;
      if (!from || from.pointer !== event.pointerId) return;
      const x = event.clientX - from.x, y = event.clientY - from.y;
      if (!drag && Math.hypot(x, y) < 6) return;
      if (!drag) event.currentTarget.setPointerCapture(event.pointerId);
      setDrag({ x, y });
    }}
    onPointerUp={event => {
      const moved = drag;
      start.current = null;
      setDrag(null);
      dragged.current = !!moved;
      if (moved) onFocus(nearest(moved.x, moved.y));
      else if (focused && (event.target === event.currentTarget || (event.target as HTMLElement).classList.contains("cq-canvas-world"))) onFocus(null);
    }}
    onPointerCancel={() => { start.current = null; setDrag(null); }}>
    <div className="cq-canvas-toolbar">
      {toolbar}
      {focused && <button type="button" onClick={() => onFocus(null)} title={t("tiles.overviewHint")}><Icon name="stack" size={15} />{t("tiles.overview")}</button>}
    </div>
    {size.width > 0 && <div className="cq-canvas-world" data-dragging={drag ? true : undefined}
      style={{ width: world.width, height: world.height, transform: `translate(${shown.x}px, ${shown.y}px) scale(${shown.scale})` }}>
      {cards.map((card, i) => {
        const open = card.id === focused && arrived === card.id;
        return <div key={card.id} className="cq-canvas-cell" data-open={open || undefined} data-attention={needsYou(card) || undefined}
          data-urgent={card.urgentCall ? true : undefined} data-transfer-id={card.id}
          style={{ ...place(i), width: cell.width, height: cell.height }}
          onClick={() => { if (dragged.current) { dragged.current = false; return; } if (card.id !== focused) onFocus(card.id); }}>
          {open ? <div className="cq-static-card cq-canvas-card">{renderCard(card)}</div>
            : <TilePoster card={card} name={titleOf(card)} subtitle={subtitleOf(card)} ink={1 / overviewScale} width={cell.width} height={cell.height} />}
        </div>;
      })}
    </div>}
    {!cards.length && <div className="cq-empty"><h2>{t("tiles.empty")}</h2></div>}
  </div>;
}

/**
 * A card's face on the canvas. It is drawn with the full card's own classes —
 * header, bubbles, composer — laid out at the size it shows in the overview and
 * zoomed to fill its cell, so opening it only adds detail, never changes its look.
 */
function TilePoster({ card, name, subtitle, ink, width, height }: { card: QueueCard; name: string; subtitle: string; ink: number; width: number; height: number }) {
  const { t } = useI18n();
  const snapshot = useSessionSnapshot(card.harness ? card.id : "");
  const preview = tilePreview(snapshot, card.harness?.replyPreview || "");
  const status = !card.harness ? t("tiles.new")
    : card.phase === "working" ? t("tiles.working")
    : preview.status === "decision" ? t("tiles.decision")
    : card.remindAt !== undefined ? t("queue.稍后提醒")
    : t("tiles.waiting");
  return <div className="cq-tile" data-status={preview.status} style={{ width: width / ink, height: height / ink, zoom: ink } as CSSProperties}>
    <div className="cq-card-header">
      <div className="cq-card-identity"><div className="cq-card-heading"><div className="cq-card-title-split">
        <h2>{name}</h2>
        {card.nickname && <span className="cq-card-nickname" style={{ "--cq-nickname-hue": nicknameHue(card.id) } as CSSProperties}>{card.nickname}</span>}
      </div></div>
      <div className="cq-card-state"><i className={card.phase === "working" ? "cq-dot" : "cq-ready-dot"} />{status}<span>{subtitle}</span></div></div>
    </div>
    <div className="cq-harness-body cq-acp"><div className="cq-acp-transcript cq-tile-transcript">
      {preview.ask && (preview.ask.sender
        ? <div className="cq-acp-msg cq-acp-msg--in"><small className="cq-acp-msg-label">来自 {preview.ask.sender.name}</small><p>{preview.ask.text}</p></div>
        : <div className="cq-acp-user-group"><div className="cq-acp-user"><p>{preview.ask.text}</p></div></div>)}
      {preview.activity && <div className="cq-acp-activity cq-tile-activity"><span>{preview.activity}</span></div>}
      {preview.text && <div className="cq-tile-reply"><MarkdownMessage content={preview.text} role="assistant" /></div>}
    </div></div>
    <div className="fc-composer cq-tile-composer"><span>{t("composer.placeholder")}</span></div>
  </div>;
}
