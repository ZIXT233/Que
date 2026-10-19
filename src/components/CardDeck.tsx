"use client";
// The queue: the cards side by side, one slot each, all the same size. The
// browser's own horizontal scrolling and snapping moves them — on its scrolling
// thread, so a swipe keeps up even while a conversation loads — and nothing runs
// per frame beyond tracking the nearest card. It turns bright as it passes the
// middle; its conversation becomes active only once scrolling stops.
import { useI18n } from "@/hooks/useI18n";
import { memo, startTransition, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { hasUrgentCall } from "@/lib/urgent-call";
import type { QueueCard } from "@/lib/card-queue";

const GAP = 24;
/** Cards this close to the front one get their conversation, one per idle moment. */
const LIVE_RANGE = 2;
/** Recently opened conversations keep their DOM and reading position. */
const RECENT_CARDS = 8;

/** The deck's card slots: the track's own children, never a selector search through the cards' conversations. */
const deckLayers = (scroller: HTMLElement | null) =>
  [...(scroller?.firstElementChild?.children ?? [])].filter((layer): layer is HTMLElement => layer.classList.contains("cq-deck-layer"));
const frontLayer = (scroller: HTMLElement | null) => deckLayers(scroller).find(layer => layer.getAttribute("aria-hidden") === "false");

// A card's content renders on card and focus changes, never because the deck scrolled.
const DeckContent = memo(function DeckContent({ card, isFront, renderCard }: {
  card: QueueCard; isFront: boolean;
  renderCard: (card: QueueCard, isFront: boolean) => ReactNode;
}) { return renderCard(card, isFront); });

export function CardDeck({ cards, focusedIndex, resetKey, navigationRef, onIndexChange, renderCard, renderPreview, suspended = false, withheldCardId = null }: {
  cards: QueueCard[];
  resetKey: number;
  focusedIndex: number;
  navigationRef: RefObject<((direction: number) => void) | null>;
  suspended?: boolean;
  withheldCardId?: string | null;
  onIndexChange: (index: number) => void;
  renderCard: (card: QueueCard, isFront: boolean) => ReactNode;
  renderPreview: (card: QueueCard) => ReactNode;
}) {
  const { t } = useI18n();
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(900);
  const step = width + GAP;
  const stepRef = useRef(step);
  stepRef.current = step;
  const orderKey = JSON.stringify(cards.map((card) => card.id));
  // Stable DOM order keeps the focused composer's node in place when the queue
  // reorders; each card's place on screen comes from its flex `order`.
  const stableCards = useMemo(() => cards.map((card, index) => ({ card, index }))
    .sort((a, b) => a.card.id.localeCompare(b.card.id)), [cards]);
  // The nearest layer follows the gesture; conversation focus stays in the
  // shell until scrolling ends. Explicit queue focus rebases both.
  const [rest, setRest] = useState({ orderKey, resetKey, focusedIndex, selected: focusedIndex });
  const rebased = rest.orderKey !== orderKey || rest.resetKey !== resetKey || rest.focusedIndex !== focusedIndex;
  if (rebased) setRest({ orderKey, resetKey, focusedIndex, selected: focusedIndex });
  const selected = Math.min(cards.length - 1, Math.max(0, rebased ? focusedIndex : rest.selected));
  const reported = useRef(focusedIndex);
  const onIndexRef = useRef(onIndexChange);
  onIndexRef.current = onIndexChange;
  const [liveCards, setLiveCards] = useState<Set<string>>(() => new Set());
  const recentCards = useRef<string[]>([]);
  const [scrolling, setScrolling] = useState(false);
  const scrollingRef = useRef(false);

  // Only the light deck layer follows the gesture. Reporting focus to the shell
  // also expands history and resumes the session, so wait until it comes to rest.
  const preview = () => {
    const element = scrollerRef.current;
    if (!element) return null;
    const index = Math.max(0, Math.min(cards.length - 1, Math.round(element.scrollLeft / stepRef.current)));
    setRest(current => current.selected === index ? current : { ...current, selected: index });
    return index;
  };
  const settle = () => {
    const element = scrollerRef.current;
    if (!element || element.classList.contains("cq-pointer-drag") || element.classList.contains("cq-vertical-wheel")) return;
    const index = preview();
    if (index === null) return;
    scrollingRef.current = false;
    setScrolling(false);
    if (index !== reported.current) {
      reported.current = index;
      onIndexRef.current(index);
    }
  };
  const settleRef = useRef(settle);
  settleRef.current = settle;
  const scrollIdle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(scrollIdle.current), []);
  const onScroll = () => {
    const element = scrollerRef.current;
    if (!element) return;
    if (!scrollingRef.current) {
      scrollingRef.current = true;
      setScrolling(true);
    }
    preview();
    clearTimeout(scrollIdle.current);
    // Native scrollend also waits for the gesture and snapping to finish. Older
    // engines use an idle timeout, guarded against an ongoing mouse drag/wheel.
    if (!("onscrollend" in element)) {
      scrollIdle.current = setTimeout(() => settleRef.current(), 120);
    }
  };

  // Stage width is the card width; the scroller reaches past the stage to the
  // layout's edges (the bleeds), so the neighbours show there.
  useLayoutEffect(() => {
    const element = scrollerRef.current;
    if (!element) return;
    const measure = () => {
      const stage = element.parentElement;
      const layout = element.closest(".cq-layout");
      if (stage && layout) {
        const box = stage.getBoundingClientRect(), outer = layout.getBoundingClientRect();
        element.style.setProperty("--cq-deck-bleed-left", `${Math.max(GAP, box.left - outer.left)}px`);
        element.style.setProperty("--cq-deck-bleed-right", `${Math.max(GAP, outer.right - box.right)}px`);
      }
      if (stage) setWidth(stage.clientWidth);
    };
    const observer = new ResizeObserver(measure);
    measure();
    observer.observe(element);
    if (element.parentElement) observer.observe(element.parentElement);
    return () => observer.disconnect();
  }, []);

  // The queue's focus moves the deck; the deck's own scrolling is never echoed back.
  const anchored = useRef<{ orderKey: string; resetKey: number; step: number } | null>(null);
  useLayoutEffect(() => {
    const previous = anchored.current;
    if (!previous || previous.orderKey !== orderKey || previous.resetKey !== resetKey || previous.step !== step || reported.current !== focusedIndex) {
      scrollerRef.current?.scrollTo({ left: focusedIndex * step, behavior: "instant" });
      reported.current = focusedIndex;
    }
    anchored.current = { orderKey, resetKey, step };
  }, [orderKey, resetKey, focusedIndex, step]);

  useEffect(() => {
    const element = scrollerRef.current;
    if (!element || suspended) return;
    const surface = (element.closest(".cq-main") ?? element) as HTMLElement;
    const smooth = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth";
    const current = () => Math.round(element.scrollLeft / stepRef.current);
    const scrollToCard = (index: number) => {
      const last = Math.max(0, deckLayers(element).length - 1);
      const left = Math.max(0, Math.min(last, index)) * stepRef.current;
      if (Math.abs(element.scrollLeft - left) < 1) { settleRef.current(); return; }
      element.scrollTo({ left, behavior: smooth() });
    };
    navigationRef.current = direction => scrollToCard(current() + direction);
    const outsideFront = (target: EventTarget | null) => {
      const front = frontLayer(element);
      return !(target instanceof Node && front?.contains(target));
    };
    // A vertical wheel outside the front card moves along the queue; inside it,
    // the wheel belongs to the conversation. Horizontal wheels are native.
    let wheeling: ReturnType<typeof setTimeout> | undefined;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey || event.defaultPrevented || !event.cancelable) return;
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX) * 1.5 || !outsideFront(event.target)) return;
      if (event.target instanceof Element && event.target.closest("button,a,input,textarea,select,[contenteditable]")) return;
      event.preventDefault();
      element.classList.add("cq-vertical-wheel");
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? stepRef.current : 1;
      element.scrollBy({ left: event.deltaY * unit, behavior: "instant" });
      clearTimeout(wheeling);
      wheeling = setTimeout(() => { element.classList.remove("cq-vertical-wheel"); scrollToCard(current()); }, 180);
    };
    // A mouse has no swipe: dragging outside the front card moves the queue.
    let drag: { id: number; startX: number; startScroll: number; moved: boolean } | null = null;
    let suppressClickUntil = 0;
    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType !== "mouse" || !event.isPrimary || event.button !== 0 || drag || !outsideFront(event.target)) return;
      drag = { id: event.pointerId, startX: event.clientX, startScroll: element.scrollLeft, moved: false };
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!drag || drag.id !== event.pointerId) return;
      const travel = drag.startX - event.clientX;
      if (!drag.moved && Math.abs(travel) < 6) return;
      if (!drag.moved) {
        drag.moved = true;
        element.classList.add("cq-pointer-drag");
        surface.setPointerCapture(event.pointerId);
        surface.classList.add("cq-deck-dragging");
      }
      event.preventDefault();
      element.scrollTo({ left: drag.startScroll + travel, behavior: "instant" });
    };
    const endDrag = (event: PointerEvent) => {
      if (!drag || drag.id !== event.pointerId) return;
      const moved = drag.moved;
      drag = null;
      surface.classList.remove("cq-deck-dragging");
      element.classList.remove("cq-pointer-drag");
      if (surface.hasPointerCapture(event.pointerId)) surface.releasePointerCapture(event.pointerId);
      if (moved) { suppressClickUntil = performance.now() + 250; scrollToCard(current()); }
    };
    // A click on a neighbour brings it to the front.
    const onClick = (event: MouseEvent) => {
      if (performance.now() < suppressClickUntil) { event.preventDefault(); event.stopPropagation(); return; }
      const slide = event.target instanceof Element ? event.target.closest<HTMLElement>(".cq-deck-layer[aria-hidden='true']") : null;
      if (!slide || !element.contains(slide)) return;
      event.preventDefault();
      scrollToCard(Number(slide.dataset.deckIndex));
    };
    // In the deck, text can be selected in the front card only. The cards
    // around it are inert, and WebKit cannot place a selection in them: it keeps
    // searching, a character at a time across their conversations, for a place
    // that can hold one, on every frame while the selection stays (seen on
    // macOS after a press for Look Up). Such a selection is dropped at once.
    const onSelection = () => {
      const selection = document.getSelection();
      if (!selection?.rangeCount) return;
      const stray = [selection.anchorNode, selection.focusNode].some(node => {
        const at = node instanceof Element ? node : node?.parentElement;
        return !!at && element.contains(at) && !at.closest('.cq-deck-layer[aria-hidden="false"]');
      });
      if (stray) selection.removeAllRanges();
    };
    const onScrollEnd = () => { clearTimeout(scrollIdle.current); settleRef.current(); };
    element.addEventListener("scrollend", onScrollEnd);
    surface.addEventListener("wheel", onWheel, { capture: true, passive: false });
    surface.addEventListener("pointerdown", onPointerDown);
    surface.addEventListener("pointermove", onPointerMove, { passive: false });
    surface.addEventListener("pointerup", endDrag);
    surface.addEventListener("pointercancel", endDrag);
    surface.addEventListener("lostpointercapture", endDrag);
    surface.addEventListener("click", onClick, true);
    document.addEventListener("selectionchange", onSelection);
    return () => {
      navigationRef.current = null;
      clearTimeout(wheeling);
      element.removeEventListener("scrollend", onScrollEnd);
      surface.removeEventListener("wheel", onWheel, true);
      surface.removeEventListener("pointerdown", onPointerDown);
      surface.removeEventListener("pointermove", onPointerMove);
      surface.removeEventListener("pointerup", endDrag);
      surface.removeEventListener("pointercancel", endDrag);
      surface.removeEventListener("lostpointercapture", endDrag);
      surface.removeEventListener("click", onClick, true);
      document.removeEventListener("selectionchange", onSelection);
      surface.classList.remove("cq-deck-dragging");
      element.classList.remove("cq-pointer-drag", "cq-vertical-wheel");
      if (drag && surface.hasPointerCapture(drag.id)) surface.releasePointerCapture(drag.id);
    };
  }, [suspended, orderKey, resetKey, navigationRef]);

  useEffect(() => {
    const id = cards[focusedIndex]?.id;
    if (id && id !== withheldCardId) recentCards.current = [id, ...recentCards.current.filter(previous => previous !== id)].slice(0, RECENT_CARDS);
  }, [cards, focusedIndex, withheldCardId]);

  // Warm nearby conversations at rest. Keep recent visits as well, so swiping
  // back reuses their DOM instead of unloading and rebuilding the same card.
  useEffect(() => {
    if (scrolling) return;
    const near = (index: number) => Math.abs(index - focusedIndex) <= LIVE_RANGE;
    const kept = new Set([...liveCards].filter(id => {
      const index = cards.findIndex(card => card.id === id);
      return index >= 0 && (near(index) || recentCards.current.includes(id));
    }));
    // The focused conversation is already mounted, even before an idle load.
    const focusedId = cards[focusedIndex]?.id;
    if (focusedId && focusedId !== withheldCardId) kept.add(focusedId);
    if (kept.size !== liveCards.size || [...kept].some(id => !liveCards.has(id))) { setLiveCards(kept); return; }
    if (suspended) return;
    const next = cards.map((card, index) => ({ card, distance: Math.abs(index - focusedIndex) }))
      .filter(({ card, distance }) => distance <= LIVE_RANGE && card.id !== withheldCardId && !liveCards.has(card.id))
      .sort((a, b) => a.distance - b.distance)[0];
    if (!next) return;
    const load = () => {
      if (scrollingRef.current) return;
      startTransition(() => setLiveCards(previous => scrollingRef.current ? previous : new Set(previous).add(next.card.id)));
    };
    if (typeof window.requestIdleCallback === "function") {
      const idle = window.requestIdleCallback(load, { timeout: 100 });
      return () => window.cancelIdleCallback(idle);
    }
    const timer = setTimeout(load, 32);
    return () => clearTimeout(timer);
  }, [cards, focusedIndex, liveCards, suspended, withheldCardId, scrolling]);

  return <div className="cq-deck-scroller" inert={suspended} aria-hidden={suspended} ref={scrollerRef} onScroll={onScroll} aria-label={t("queue.左右滑动浏览卡片，停下后自动吸附")}>
    <div className="cq-deck-track">
      {stableCards.map(({ card, index }) => {
        const isFront = index === selected;
        const live = card.id !== withheldCardId && (index === focusedIndex || liveCards.has(card.id));
        return <div key={card.id} className="cq-deck-layer" data-urgent-call={hasUrgentCall(card)} data-transfer-id={suspended ? undefined : card.id} data-transfer-zone="deck" data-deck-index={index} aria-hidden={!isFront}
          style={{ order: index, width }}>
          <div className="cq-deck-layer-body" inert={!isFront}>
            {live ? <DeckContent card={card} isFront={index === focusedIndex && !suspended} renderCard={renderCard} /> : <DeckContent card={card} isFront={false} renderCard={renderPreview} />}
          </div>
        </div>;
      })}
      {/* Room after the last card, so it can come to rest at the start like the others
          (WebKitGTK leaves a scroller's end padding out of its scroll range). */}
      <div className="cq-deck-end" aria-hidden="true" style={{ order: cards.length }} />
    </div>
  </div>;
}
