import type { CardQueue } from "./card-queue.ts";
import type { SessionInfo } from "./types.ts";

/** Keep the previous object when a poll only rebuilt the same JSON. */
export function reuseIfEqual<T>(current: T, next: T): T {
  return current !== undefined && JSON.stringify(current) === JSON.stringify(next) ? current : next;
}

/** Coalesce bursty SSE hook notifications before a full /api/card-queue reconcile. */
export const QUEUE_SSE_REFRESH_MS = 200;

export const QUEUE_LIVE_POLL_MS = 8_000;
export const QUEUE_HIDDEN_POLL_MS = 20_000;
export const QUEUE_OFFLINE_POLL_MS = 1_200;
export const QUEUE_OFFLINE_HIDDEN_POLL_MS = 3_000;

/** Busy boards stay at 1.2s so hook transitions land; idle boards can wait. */
export function queuePollIntervalMs(queue: CardQueue | null, visible: boolean): number {
  if (!visible) return QUEUE_LIVE_POLL_MS;
  if (!queue) return QUEUE_OFFLINE_POLL_MS;
  const busy = queue.cards.some((card) => card.archivedAt === undefined && (
    card.phase === "working"
    || card.harness?.state === "working"
    || card.harness?.state === "starting"
  ));
  return busy ? QUEUE_OFFLINE_POLL_MS : 4_000;
}

export function queueFallbackPollMs(visible: boolean, liveConnected: boolean): number {
  if (liveConnected) return visible ? QUEUE_LIVE_POLL_MS : QUEUE_HIDDEN_POLL_MS;
  return visible ? QUEUE_OFFLINE_POLL_MS : QUEUE_OFFLINE_HIDDEN_POLL_MS;
}

/** Polls are complete JSON snapshots; preserve identities for unchanged cards. */
export function mergeQueueSnapshot(previous: CardQueue | null, next: CardQueue): CardQueue {
  if (!previous) return next;
  if (next.revision < previous.revision) return previous;
  // Compare content too: local optimistic updates retain the server revision.
  if (JSON.stringify(previous) === JSON.stringify(next)) return previous;
  const cards = new Map(previous.cards.map(card => [card.id, card]));
  return { ...next, cards: next.cards.map(card => {
    const existing = cards.get(card.id);
    return existing && JSON.stringify(existing) === JSON.stringify(card) ? existing : card;
  }) };
}

/** Move an accepted prompt out of the attention deck before the next server snapshot. */
export function markQueueCardWorking(
  queue: CardQueue,
  cardId: string,
  session?: SessionInfo,
): CardQueue {
  const target = queue.cards.find((card) => card.id === cardId);
  const activeSession = target?.session ?? session;
  if (!target) return queue;

  return {
    ...queue,
    order: queue.order.filter((id) => id !== cardId),
    cards: queue.cards.map((card) => card.id === cardId
      ? {
          ...card,
          session: activeSession ?? null,
          phase: "working" as const,
          readyAt: undefined,
          waitingSince: undefined,
          turnKey: undefined,
          urgentCall: undefined,
          turnTags: undefined,
          tagEvaluation: undefined,
        }
      : card),
  };
}

/** Earliest minute boundary that can change a visible waiting score. */
export function nextQueueScoreChange(queue: CardQueue, now: number): number | null {
  if (queue.sortMode !== "score") return null;
  let next = Infinity;
  for (const card of queue.cards) {
    if (card.readyAt === undefined || card.phase !== "attention" || card.detached || card.archivedAt !== undefined) continue;
    const start = card.waitingSince ?? card.readyAt;
    const minutes = Math.max(0, Math.floor((now - start) / 60_000));
    if (minutes < 99) next = Math.min(next, start + (minutes + 1) * 60_000);
  }
  return Number.isFinite(next) ? next : null;
}
