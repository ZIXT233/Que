// Every connected conversation on one stream (/api/acp/events), folded per card
// with the same rules as a single conversation. It is the app's only session
// stream: a browser opens only a few connections per host, and one stream per
// card would starve the rest. A view that keeps its own state (the conversation,
// with its optimistic turns) takes the raw events of its card instead.
import { useSyncExternalStore } from "react";
import { foldEvents, type Delta, type StreamEvent } from "./acp-delta";

export type SessionBlock = { type: string; stream?: string; text?: string; title?: string; status?: string; state?: string; kind?: string; request?: any;
  direction?: string; from?: { cardId: string; name: string }; to?: { cardId: string; name: string }[]; all?: boolean };
export type SessionTurn = { id: string; text: string; state: string; source?: string; withdrawn?: boolean; sender?: { cardId: string; name: string }; blocks: SessionBlock[] };
export type SessionSnapshot = { ownerEpoch?: string; revision?: number; state?: string; stage?: string; startLog?: { at: number; text: string }[]; turns: SessionTurn[] };

const snapshots = new Map<string, SessionSnapshot>();
const listeners = new Map<string, Set<() => void>>();
const handlers = new Map<string, Set<(event: StreamEvent<SessionSnapshot>) => void>>();
const health = new Set<() => void>();
let source: EventSource | undefined;
let retry: ReturnType<typeof setTimeout> | undefined;
let failures = 0;

function changed(id: string) { listeners.get(id)?.forEach(listener => listener()); }
function setFailures(count: number) {
  const wasHealthy = failures < 3;
  failures = count;
  if (wasHealthy !== failures < 3) health.forEach(listener => listener());
}

async function resync(id: string) {
  try {
    const response = await fetch(`/api/acp/${encodeURIComponent(id)}`, { cache: "no-store" });
    if (response.ok) { snapshots.set(id, await response.json()); changed(id); }
  } catch { /* the stream keeps trying */ }
}

function apply(id: string, event: StreamEvent<SessionSnapshot>) {
  handlers.get(id)?.forEach(handler => handler(event));
  const { snapshot, gap } = foldEvents(snapshots.get(id), [event]);
  if (snapshot && snapshot !== snapshots.get(id)) { snapshots.set(id, snapshot); changed(id); }
  if (gap && listeners.has(id)) void resync(id);
}

function connect() {
  const opened = new EventSource("/api/acp/events");
  source = opened;
  const read = (event: Event) => JSON.parse((event as MessageEvent).data) as { id: string; data: unknown };
  opened.addEventListener("snapshot", event => { setFailures(0); const { id, data } = read(event); apply(id, { event: "snapshot", data: data as SessionSnapshot }); });
  opened.addEventListener("delta", event => { const { id, data } = read(event); apply(id, { event: "delta", data: data as Delta }); });
  opened.onerror = () => {
    if (source !== opened) return;
    // A failed read says nothing about the sessions: keep their last state.
    setFailures(failures + 1);
    // EventSource gives up on a refused stream; reopen it with a short backoff.
    if (opened.readyState !== EventSource.CLOSED) return;
    source = undefined;
    retry = setTimeout(connect, Math.min(1000 * failures, 8000));
  };
}

/** Opens the stream while anything listens, and closes it when nothing does. */
function hold() {
  if (!source && !retry) connect();
  return () => {
    if (listeners.size || handlers.size) return;
    source?.close(); source = undefined; clearTimeout(retry); retry = undefined;
  };
}

function subscribe(id: string, listener: () => void) {
  if (!id) return () => {};
  let set = listeners.get(id);
  if (!set) listeners.set(id, set = new Set());
  set.add(listener);
  const release = hold();
  return () => {
    set!.delete(listener);
    if (!set!.size) listeners.delete(id);
    release();
  };
}

/** The raw snapshot and delta events of one card, in order, for a view that folds them itself. */
export function subscribeSessionEvents(id: string, handler: (event: StreamEvent<SessionSnapshot>) => void) {
  let set = handlers.get(id);
  if (!set) handlers.set(id, set = new Set());
  set.add(handler);
  const release = hold();
  return () => {
    set!.delete(handler);
    if (!set!.size) handlers.delete(id);
    release();
  };
}

/** What the shared stream already knows of a card, without subscribing. */
export const peekSessionSnapshot = (id: string) => snapshots.get(id);

/** The live conversation of a connected card; undefined until it is connected, or for "". */
export function useSessionSnapshot(id: string): SessionSnapshot | undefined {
  return useSyncExternalStore(listener => subscribe(id, listener), () => snapshots.get(id), () => undefined);
}

/** False once the stream has failed a few times in a row, until it delivers again. */
export function useSessionStreamHealthy(): boolean {
  return useSyncExternalStore(listener => { health.add(listener); return () => health.delete(listener); }, () => failures < 3, () => true);
}
