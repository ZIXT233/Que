// Every connected conversation on one stream (/api/acp/events), folded per card
// with the same rules as a single conversation. A browser opens only a few
// connections per host, so views that show many cards at once share this one.
import { useSyncExternalStore } from "react";
import { foldEvents, type Delta, type StreamEvent } from "./acp-delta";

export type SessionBlock = { type: string; stream?: string; text?: string; title?: string; status?: string; state?: string; kind?: string; request?: any; direction?: string };
export type SessionTurn = { id: string; text: string; state: string; source?: string; withdrawn?: boolean; sender?: { cardId: string; name: string }; blocks: SessionBlock[] };
export type SessionSnapshot = { ownerEpoch?: string; revision?: number; state?: string; turns: SessionTurn[] };

const snapshots = new Map<string, SessionSnapshot>();
const listeners = new Map<string, Set<() => void>>();
let source: EventSource | undefined;
let retry: ReturnType<typeof setTimeout> | undefined;
let failures = 0;

function changed(id: string) { listeners.get(id)?.forEach(listener => listener()); }

async function resync(id: string) {
  try {
    const response = await fetch(`/api/acp/${encodeURIComponent(id)}`, { cache: "no-store" });
    if (response.ok) { snapshots.set(id, await response.json()); changed(id); }
  } catch { /* the stream keeps trying */ }
}

function apply(id: string, event: StreamEvent<SessionSnapshot>) {
  const { snapshot, gap } = foldEvents(snapshots.get(id), [event]);
  if (snapshot && snapshot !== snapshots.get(id)) { snapshots.set(id, snapshot); changed(id); }
  if (gap) void resync(id);
}

function connect() {
  const opened = new EventSource("/api/acp/events");
  source = opened;
  const read = (event: Event) => JSON.parse((event as MessageEvent).data) as { id: string; data: unknown };
  opened.addEventListener("snapshot", event => { failures = 0; const { id, data } = read(event); apply(id, { event: "snapshot", data: data as SessionSnapshot }); });
  opened.addEventListener("delta", event => { const { id, data } = read(event); apply(id, { event: "delta", data: data as Delta }); });
  opened.onerror = () => {
    if (source !== opened || opened.readyState !== EventSource.CLOSED) return;
    source = undefined;
    retry = setTimeout(connect, Math.min(1000 * ++failures, 8000));
  };
}

function subscribe(id: string, listener: () => void) {
  if (!id) return () => {};
  let set = listeners.get(id);
  if (!set) listeners.set(id, set = new Set());
  set.add(listener);
  if (!source && !retry) connect();
  return () => {
    set!.delete(listener);
    if (!set!.size) listeners.delete(id);
    if (!listeners.size) { source?.close(); source = undefined; clearTimeout(retry); retry = undefined; }
  };
}

/** What the shared stream already knows of a card, without subscribing. */
export const peekSessionSnapshot = (id: string) => snapshots.get(id);

/** The live conversation of a connected card; undefined until it is connected, or for "". */
export function useSessionSnapshot(id: string): SessionSnapshot | undefined {
  return useSyncExternalStore(listener => subscribe(id, listener), () => snapshots.get(id), () => undefined);
}
