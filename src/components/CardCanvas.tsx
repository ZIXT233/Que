"use client";
// Tile mode: every card on one canvas. The canvas has a single layout, with each
// cell the size of a full card; the overview is that canvas scaled down to fit.
// Opening a card zooms the whole canvas in, so its neighbours stay in place
// around it, edges in view; dragging the canvas moves to them. Only large things
// are ever scaled down, so the open card is drawn at its own size, sharp.
// Every frame, faces are laid out at the size they have on screen (--cq-zoom is
// 1 / scale): text keeps its size while the canvas zooms, and close up a face
// is laid out like its card. Moving to a neighbour mounts that card at once.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { QueueCard } from "@/lib/card-queue";
import { useSessionSnapshot } from "@/lib/session-store";
import { tilePreview } from "@/lib/card-tile";
import { useI18n } from "@/hooks/useI18n";
import { Icon } from "./QueueIcon";
import { MarkdownMessage } from "./MarkdownMessage";
import { nicknameHue } from "@/lib/card-nickname";

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
  const layout = { width: columns * cell.width + (columns - 1) * GAP, height: rows * cell.height + (rows - 1) * GAP };
  const overviewScale = Math.min(0.5, (size.width - 2 * PAD) / layout.width, (size.height - TOP - PAD) / layout.height);
  const place = (index: number) => ({ left: (index % columns) * (cell.width + GAP), top: Math.floor(index / columns) * (cell.height + GAP) });
  const index = cards.findIndex(card => card.id === focused);
  const camera = useMemo<Camera>(() => {
    if (index < 0) return { scale: overviewScale, x: (size.width - layout.width * overviewScale) / 2, y: TOP + (size.height - TOP - PAD - layout.height * overviewScale) / 2 };
    const { left, top } = place(index);
    return { scale: 1, x: (size.width - cell.width) / 2 - left, y: (size.height - cell.height) / 2 - top };
  }, [index, overviewScale, size.width, size.height, layout.width, layout.height, cell.width, cell.height, columns]);

  // The camera is painted straight onto the canvas each frame, not through React.
  const world = useRef<HTMLDivElement>(null);
  const shown = useRef<Camera | null>(null);
  const paint = (view: Camera) => {
    shown.current = view;
    if (world.current) world.current.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
    viewport.current?.style.setProperty("--cq-zoom", String(1 / view.scale));
  };
  // The open card is mounted once the zoom has arrived; between neighbours,
  // which are already close up, at once.
  const [arrived, setArrived] = useState<string | null>(null);
  useLayoutEffect(() => {
    if (!size.width) return;
    const from = shown.current, to = camera;
    if (!focused) setArrived(null);
    else if (from?.scale === 1) setArrived(focused);
    // Nothing to animate from, motion turned off, or a hidden window (where frames
    // never run, e.g. a notification opening a card while Que sits in the tray).
    if (!from || document.visibilityState === "hidden" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) { paint(to); setArrived(focused); return; }
    const begin = performance.now(), ease = (t: number) => 1 - (1 - t) ** 3;
    let frame = requestAnimationFrame(function tick(now) {
      const t = Math.min(1, (now - begin) / 320), e = ease(t);
      paint({ scale: from.scale + (to.scale - from.scale) * e, x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e });
      if (t < 1) frame = requestAnimationFrame(tick); else setArrived(focused);
    });
    return () => cancelAnimationFrame(frame);
  }, [camera, focused, size.width]);

  // Dragging pans the zoomed canvas; letting go settles on the nearest card.
  const start = useRef<{ pointer: number; x: number; y: number } | null>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);
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

  return <div ref={viewport} className="cq-canvas" data-zoomed={focused ? true : undefined}
    onPointerDown={event => {
      // Pan only from outside the open card: inside it, pointers belong to the card.
      if (!focused || event.button !== 0 || (event.target as HTMLElement).closest(".cq-canvas-cell[data-open]")) return;
      start.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY };
    }}
    onPointerMove={event => {
      const from = start.current;
      if (!from || from.pointer !== event.pointerId) return;
      const x = event.clientX - from.x, y = event.clientY - from.y;
      if (!drag.current && Math.hypot(x, y) < 6) return;
      if (!drag.current) event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { x, y };
      paint({ ...camera, x: camera.x + x, y: camera.y + y });
    }}
    onPointerUp={event => {
      const moved = drag.current;
      start.current = null;
      drag.current = null;
      dragged.current = !!moved;
      if (moved) {
        const next = nearest(moved.x, moved.y);
        // Settling back onto the same card is a camera move only.
        if (next === focused) paint(camera); else onFocus(next);
      } else if (focused && (event.target === event.currentTarget || (event.target as HTMLElement).classList.contains("cq-canvas-world"))) onFocus(null);
    }}
    onPointerCancel={() => { start.current = null; if (drag.current) paint(camera); drag.current = null; }}>
    <div className="cq-canvas-toolbar">
      {toolbar}
      {focused && <button type="button" onClick={() => onFocus(null)} title={t("tiles.overviewHint")}><Icon name="stack" size={15} />{t("tiles.overview")}</button>}
    </div>
    {size.width > 0 && <div ref={world} className="cq-canvas-world" style={{ width: layout.width, height: layout.height }}>
      {cards.map((card, i) => {
        const open = card.id === focused && arrived === card.id;
        return <div key={card.id} className="cq-canvas-cell" data-open={open || undefined} data-attention={needsYou(card) || undefined}
          data-urgent={card.urgentCall ? true : undefined} data-transfer-id={card.id}
          style={{ ...place(i), width: cell.width, height: cell.height }}
          onClick={() => { if (dragged.current) { dragged.current = false; return; } if (card.id !== focused) onFocus(card.id); }}>
          {open ? <div className="cq-static-card cq-canvas-card">{renderCard(card)}</div>
            : <TilePoster card={card} name={titleOf(card)} subtitle={subtitleOf(card)} width={cell.width} height={cell.height} />}
        </div>;
      })}
    </div>}
    {!cards.length && <div className="cq-empty"><h2>{t("tiles.empty")}</h2></div>}
  </div>;
}

/**
 * A card's face on the canvas. It is drawn with the full card's own classes —
 * header and bubbles — laid out at its size on screen and zoomed to fill its
 * cell, so it reads at any zoom and, close up, looks like its card.
 */
function TilePoster({ card, name, subtitle, width, height }: { card: QueueCard; name: string; subtitle: string; width: number; height: number }) {
  const { t } = useI18n();
  const snapshot = useSessionSnapshot(card.harness ? card.id : "");
  const preview = tilePreview(snapshot, card.harness?.replyPreview || "");
  const status = !card.harness ? t("tiles.new")
    : card.phase === "working" ? t("tiles.working")
    : preview.status === "decision" ? t("tiles.decision")
    : card.remindAt !== undefined ? t("queue.稍后提醒")
    : t("tiles.waiting");
  return <div className="cq-tile" data-status={preview.status}
    style={{ width: `calc(${width}px / var(--cq-zoom, 1))`, height: `calc(${height}px / var(--cq-zoom, 1))`, zoom: "var(--cq-zoom, 1)" } as CSSProperties}>
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
  </div>;
}
