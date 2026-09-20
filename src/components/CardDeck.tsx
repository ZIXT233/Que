"use client";
import { useI18n } from "@/hooks/useI18n";

import { memo, startTransition, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { hasUrgentCall } from "@/lib/urgent-call";
import type { QueueCard } from "@/lib/card-queue";
import { isDeckCardOffscreenLeft, deckStep, peekDeckIndexAtPoint, projectDeckCard } from "@/lib/card-deck";

// Fractional scroll frames only update the layer; conversation trees render on
// card/focus changes, not on every transform update.
const DeckContent = memo(function DeckContent({ card, isFront, renderCard }: {
  card: QueueCard; isFront: boolean;
  renderCard: (card: QueueCard, isFront: boolean) => ReactNode;
}) { return renderCard(card, isFront); });

export function CardDeck({ cards, focusedIndex, resetKey, navigationRef, onIndexChange, renderCard, suspended = false }: {
  cards: QueueCard[];
  resetKey: number;
  focusedIndex: number;
  navigationRef: RefObject<((direction: number) => void) | null>;
  suspended?: boolean;
  onIndexChange: (index: number) => void;
  renderCard: (card: QueueCard, isFront: boolean) => ReactNode;
}) {
  const { t } = useI18n();
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(900);
  const [leftBleed, setLeftBleed] = useState(24);
  const orderKey = JSON.stringify(cards.map((card) => card.id));
  const stableCards = useMemo(() => cards.map((card, index) => ({ card, index }))
    .sort((a, b) => a.card.id.localeCompare(b.card.id)), [cards]);
  const [viewport, setViewport] = useState({ orderKey, resetKey, position: focusedIndex, direction: 0 });
  // Rebase before rendering children so a reorder never unmounts or makes the
  // focused composer inert, even when it moves beyond the preview window.
  const rebased = viewport.orderKey !== orderKey || viewport.resetKey !== resetKey
    || Math.round(viewport.position) !== focusedIndex;
  const position = rebased ? focusedIndex : viewport.position;
  const settled = Math.abs(position - Math.round(position)) < .001;
  const liveCards = useRef(new Set<string>());
  const wantedCards = useRef(new Set<string>());
  const pendingLoads = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const [, bumpLive] = useState(0);
  if (rebased) setViewport({ orderKey, resetKey, position, direction: 0 });
  const frame = useRef<number | null>(null);
  const step = deckStep(width);
  const selected = Math.min(cards.length - 1, Math.max(0, Math.round(position)));
  const direction = rebased ? 0 : viewport.direction;
  const approaching = direction > 0 ? Math.ceil(position - .0001)
    : direction < 0 ? Math.floor(position + .0001) : selected;
  const onIndexRef = useRef(onIndexChange);
  onIndexRef.current = onIndexChange;
  const stepRef = useRef(step);
  stepRef.current = step;

  useEffect(() => {
    const element = scrollerRef.current;
    if (!element || suspended) return;
    const surface = (element.closest(".cq-main") ?? element) as HTMLElement;
    let keyboardTarget: number | null = null;
    let keyboardFrame = 0;
    const stopKeyboard = () => {
      cancelAnimationFrame(keyboardFrame);
      keyboardFrame = 0;
      keyboardTarget = null;
      element.classList.remove("cq-keyboard-scroll");
    };
    const scrollToCard = (index: number) => {
      element.scrollTo({ left: index * stepRef.current,
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
    };
    const peekIndexFromPoint = (clientX: number, clientY: number) => {
      const selected = Math.round(element.scrollLeft / stepRef.current);
      const front = element.querySelector<HTMLElement>('.cq-deck-layer[aria-hidden="false"]');
      const layers = [...element.querySelectorAll<HTMLElement>('.cq-deck-layer[aria-hidden="true"]')].map((layer) => {
        const rect = layer.getBoundingClientRect();
        return { index: Number(layer.dataset.deckIndex), z: Number(layer.style.zIndex) || 0, ...rect };
      });
      return peekDeckIndexAtPoint(clientX, clientY, selected, front?.getBoundingClientRect() ?? null, layers);
    };
    navigationRef.current = (direction) => {
      const maxIndex = Math.max(0, Math.round((element.scrollWidth - element.clientWidth) / stepRef.current));
      keyboardTarget = Math.max(0, Math.min(maxIndex, (keyboardTarget ?? Math.round(element.scrollLeft / stepRef.current)) + direction));
      cancelAnimationFrame(keyboardFrame);
      const target = keyboardTarget * stepRef.current;
      const origin = element.scrollLeft;
      element.classList.add("cq-keyboard-scroll");
      element.scrollTo({ left: origin, behavior: "instant" });
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        element.scrollTo({ left: target, behavior: "instant" });
        stopKeyboard();
        return;
      }
      const startedAt = performance.now();
      const tick = (now: number) => {
        const progress = Math.min(1, (now - startedAt) / 180);
        // Only the timing is keyboard-specific; native scroll position continues
        // to drive the same card projection, scale and blur as every gesture.
        element.scrollTo({ left: origin + (target - origin) * progress, behavior: "instant" });
        if (progress === 1) stopKeyboard();
        else keyboardFrame = requestAnimationFrame(tick);
      };
      keyboardFrame = requestAnimationFrame(tick);
    };
    const onScrollEnd = () => {
      if (!keyboardFrame) keyboardTarget = null;
    };
    // Only vertical gestures on navigation surfaces are translated. Horizontal
    // and diagonal gestures retain native scrolling, momentum and CSS snapping.
    let wheelMode: "native" | "vertical" | null = null;
    let wheelIdle: ReturnType<typeof setTimeout> | undefined;
    const finishWheel = () => {
      const mapped = wheelMode === "vertical";
      wheelMode = null;
      element.classList.remove("cq-vertical-wheel");
      if (mapped) scrollToCard(Math.round(element.scrollLeft / stepRef.current));
    };
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey || event.defaultPrevented) return;
      if (!event.deltaX && !event.deltaY) return;
      stopKeyboard();
      const target = event.target instanceof Element ? event.target : null;
      const front = element.querySelector('.cq-deck-layer[aria-hidden="false"]');
      const rect = front?.getBoundingClientRect();
      const outside = rect && (event.clientX < rect.left || event.clientX > rect.right
        || event.clientY < rect.top || event.clientY > rect.bottom);
      const interactive = target?.closest("button,a,input,textarea,select,summary,[contenteditable],[role=button]");
      const heading = target?.closest(".cq-card-header");
      const eligible = !interactive && (outside || (heading && front?.contains(heading)));
      // A slight diagonal is normal. Ambiguous angles favor native horizontal
      // scrolling; once chosen, the direction stays fixed through this burst.
      wheelMode ??= eligible && Math.abs(event.deltaY) > Math.abs(event.deltaX) * 1.5 ? "vertical" : "native";
      clearTimeout(wheelIdle);
      wheelIdle = setTimeout(finishWheel, 180);
      if (wheelMode !== "vertical" || !eligible || !event.cancelable) return;
      event.preventDefault();
      element.classList.add("cq-vertical-wheel");
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? stepRef.current : 1;
      element.scrollBy({ left: event.deltaY * unit, behavior: "instant" });
    };
    // Defer capture until the pointer actually moves so a click on a blurred
    // neighbor can still fire; starting a drag immediately was swallowing it.
    let drag: { id: number; startX: number; startScroll: number; moved: boolean; peek: number | null } | null = null;
    let suppressClickUntil = 0;
    const peekFromTarget = (target: Element | null, clientX: number, clientY: number) => {
      const layer = target?.closest<HTMLElement>(".cq-deck-layer[aria-hidden='true']");
      if (layer) {
        const index = Number(layer.dataset.deckIndex);
        const current = Math.round(element.scrollLeft / stepRef.current);
        if (Number.isInteger(index) && Math.abs(index - current) === 1) return index;
      }
      return peekIndexFromPoint(clientX, clientY);
    };
    const onPointerDown = (event: PointerEvent) => {
      // Touch uses native panning too. Only a held mouse button needs emulation.
      if (event.pointerType !== "mouse" || !event.isPrimary || event.button !== 0 || drag) return;
      const target = event.target instanceof Element ? event.target : null;
      const peekHit = target?.closest(".cq-deck-peek-hit");
      if (!peekHit && target?.closest("button,a,input,textarea,select,summary,[contenteditable],[role=button]")) return;
      const front = element.querySelector('.cq-deck-layer[aria-hidden="false"]');
      const rect = front?.getBoundingClientRect();
      if (!peekHit && rect && event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom) return;
      stopKeyboard();
      drag = {
        id: event.pointerId,
        startX: event.clientX,
        startScroll: element.scrollLeft,
        moved: false,
        peek: peekFromTarget(target, event.clientX, event.clientY),
      };
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!drag || drag.id !== event.pointerId) return;
      const travel = drag.startX - event.clientX;
      if (!drag.moved && Math.abs(travel) < 6) return;
      if (!drag.moved) {
        drag.moved = true;
        drag.peek = null;
        element.classList.add("cq-pointer-drag");
        element.scrollTo({ left: element.scrollLeft, behavior: "instant" });
        surface.setPointerCapture(event.pointerId);
        surface.classList.add("cq-deck-dragging");
        surface.dispatchEvent(new Event("cq-deck-drag-start", { bubbles: true }));
      }
      event.preventDefault();
      element.scrollTo({ left: drag.startScroll + travel, behavior: "instant" });
    };
    const endDrag = (event: PointerEvent) => {
      if (!drag || drag.id !== event.pointerId) return;
      const moved = drag.moved;
      const peek = drag.peek;
      const targetIndex = Math.round(element.scrollLeft / stepRef.current);
      drag = null;
      surface.classList.remove("cq-deck-dragging");
      element.classList.remove("cq-pointer-drag");
      if (surface.hasPointerCapture(event.pointerId)) surface.releasePointerCapture(event.pointerId);
      if (moved) {
        suppressClickUntil = performance.now() + 250;
        scrollToCard(targetIndex);
        return;
      }
      if (peek != null) {
        suppressClickUntil = performance.now() + 250;
        scrollToCard(peek);
      }
    };
    const onClick = (event: MouseEvent) => {
      if (performance.now() < suppressClickUntil) { event.preventDefault(); event.stopPropagation(); return; }
      const target = event.target instanceof Element ? event.target : null;
      const peekHit = target?.closest(".cq-deck-peek-hit");
      if (!peekHit && target?.closest("button,a,input,textarea,select,summary,[contenteditable],[role=button]")) return;
      const peek = peekFromTarget(target, event.clientX, event.clientY);
      if (peek == null) return;
      event.preventDefault();
      scrollToCard(peek);
    };
    element.addEventListener("scrollend", onScrollEnd);
    surface.addEventListener("wheel", onWheel, { capture: true, passive: false });
    surface.addEventListener("pointerdown", onPointerDown);
    surface.addEventListener("pointermove", onPointerMove, { passive: false });
    surface.addEventListener("pointerup", endDrag);
    surface.addEventListener("pointercancel", endDrag);
    surface.addEventListener("lostpointercapture", endDrag);
    surface.addEventListener("click", onClick, true);
    return () => {
      navigationRef.current = null;
      stopKeyboard();
      element.removeEventListener("scrollend", onScrollEnd);
      surface.removeEventListener("wheel", onWheel, true);
      clearTimeout(wheelIdle);
      element.classList.remove("cq-vertical-wheel");
      surface.removeEventListener("pointerdown", onPointerDown);
      surface.removeEventListener("pointermove", onPointerMove);
      surface.removeEventListener("pointerup", endDrag);
      surface.removeEventListener("pointercancel", endDrag);
      surface.removeEventListener("lostpointercapture", endDrag);
      surface.removeEventListener("click", onClick, true);
      surface.classList.remove("cq-deck-dragging", "cq-deck-peek-hover");
      element.classList.remove("cq-pointer-drag");
      if (drag && surface.hasPointerCapture(drag.id)) surface.releasePointerCapture(drag.id);
    };
  }, [suspended, orderKey, resetKey, navigationRef]);

  useLayoutEffect(() => {
    const element = scrollerRef.current;
    if (!element) return;
    const measure = () => {
      const stage = element.parentElement;
      const layout = element.closest(".cq-layout");
      if (stage && layout) {
        const bleed = Math.max(24, stage.getBoundingClientRect().left - layout.getBoundingClientRect().left);
        element.style.setProperty("--cq-deck-bleed-left", `${bleed}px`);
        setLeftBleed(bleed);
        const rightBleed = Math.max(24, layout.getBoundingClientRect().right - stage.getBoundingClientRect().right);
        element.style.setProperty("--cq-deck-bleed-right", `${rightBleed}px`);
      }
      const style = getComputedStyle(element);
      setWidth(element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
    };
    const observer = new ResizeObserver(measure);
    measure();
    observer.observe(element);
    if (element.parentElement) observer.observe(element.parentElement);
    return () => observer.disconnect();
  }, []);

  const reportedIndex = useRef(focusedIndex);
  const anchoredLayout = useRef<{ orderKey: string; resetKey: number; step: number } | null>(null);
  useLayoutEffect(() => {
    const previous = anchoredLayout.current;
    const layoutChanged = !previous || previous.orderKey !== orderKey || previous.resetKey !== resetKey || previous.step !== step;
    // Native scroll updates must never be echoed back through scrollTo: that
    // interrupts the browser's gesture and snapping animation on every frame.
    if (layoutChanged || reportedIndex.current !== focusedIndex) {
      if (frame.current !== null) { cancelAnimationFrame(frame.current); frame.current = null; }
      scrollerRef.current?.scrollTo({ left: position * step, behavior: "instant" });
      reportedIndex.current = focusedIndex;
    }
    anchoredLayout.current = { orderKey, resetKey, step };
  }, [orderKey, resetKey, focusedIndex, step, position]);

  useEffect(() => () => { if (frame.current !== null) cancelAnimationFrame(frame.current); }, []);

  // While the deck moves, card content loads off the gesture's critical path:
  // silhouettes slide first and real cards pop in when ready. A card that has
  // scrolled out of the near window before its turn skips the render entirely.
  useEffect(() => {
    if (settled || suspended) return;
    for (const id of wantedCards.current) {
      if (liveCards.current.has(id) || pendingLoads.current.has(id)) continue;
      pendingLoads.current.set(id, setTimeout(() => {
        pendingLoads.current.delete(id);
        if (!wantedCards.current.has(id) || liveCards.current.has(id)) return;
        liveCards.current.add(id);
        startTransition(() => bumpLive((n) => n + 1));
      }, 0));
    }
  });
  useEffect(() => () => {
    for (const timer of pendingLoads.current.values()) clearTimeout(timer);
    pendingLoads.current.clear();
  }, []);

  const syncPosition = () => {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const position = Math.max(0, Math.min(Math.max(0, cards.length - 1), (scrollerRef.current?.scrollLeft ?? 0) / stepRef.current));
      const nextIndex = Math.max(0, Math.min(cards.length - 1, Math.round(position)));
      const indexChanged = nextIndex !== reportedIndex.current;
      reportedIndex.current = nextIndex;
      setViewport((previous) => {
        if (previous.orderKey === orderKey && previous.resetKey === resetKey
          && Math.abs(position - previous.position) <= .0001) return previous;
        return { orderKey, resetKey, position,
          direction: previous.orderKey === orderKey && previous.resetKey === resetKey
            ? Math.sign(position - previous.position) : 0 };
      });
      if (indexChanged) onIndexRef.current(nextIndex);
    });
  };

  const wanted = new Set<string>();
  for (const { card, index } of stableCards)
    if (Math.abs(index - selected) <= 1) wanted.add(card.id);
  wantedCards.current = wanted;

  // Native horizontal gestures browse cards; vertical mapping is limited to navigation surfaces.
  return <div className="cq-deck-scroller" inert={suspended} aria-hidden={suspended} ref={scrollerRef} onScroll={syncPosition} aria-label={t("queue.左右滑动浏览卡片，停下后自动吸附")}>
    <div className="cq-deck-track" style={{ width: width + Math.max(0, cards.length - 1) * step }}>
      <div className="cq-deck-sticky" style={{ width }}>
        {/* Stable DOM order avoids moving the focused input node on score changes.
            Scheduler indexes still determine every card's visual position. */}
        {stableCards.map(({ card, index }) => {
          const { distance, x, scale } = projectDeckCard(index, position, width);
          if (isDeckCardOffscreenLeft(x, width, leftBleed) || distance > 5) return null;
          const isFront = index === selected;
          const isNeighbor = Math.abs(index - selected) === 1;
          // Mounting a conversation tree mid-gesture stalls the slide: while
          // the deck moves, mounts only land through the async queue above.
          const live = liveCards.current.has(card.id)
            || (settled && (isFront || isNeighbor));
          if (live) liveCards.current.add(card.id);
          return <div key={card.id} className="cq-deck-layer" data-clear={isFront || index === approaching} data-urgent-call={hasUrgentCall(card)} data-transfer-id={suspended ? undefined : card.id} data-transfer-zone="attention" data-deck-index={index} aria-hidden={!isFront}
            style={{ transform: `translate3d(${x}px, 0, 0) scale(${scale})`, zIndex: cards.length - index, pointerEvents: "auto" }}>
            <div className="cq-deck-layer-body" inert={!isFront}>
              {live ? <DeckContent card={card} isFront={isFront} renderCard={renderCard} /> : <div className="cq-back-card" />}
            </div>
            {isNeighbor ? <button type="button" className="cq-deck-peek-hit" tabIndex={-1} aria-label={index < selected ? t("queue.上一张卡片") : t("queue.下一张卡片")} /> : null}
          </div>;
        })}
      </div>
      {cards.map((card, index) => <div className="cq-snap-point" key={card.id} style={{ left: index * step }} aria-hidden="true" />)}
    </div>
  </div>;
}
