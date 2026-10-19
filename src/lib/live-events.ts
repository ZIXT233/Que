// What changed in Que (/api/card-queue/events): one stream for the window, each
// event naming its reason ("queue", "acp", "channels", …). Views refetch what
// the reason concerns; nothing polls for it.
type Listener = { change?: (reason: string) => void; open?: () => void; error?: (closed: boolean) => void };

const listeners = new Set<Listener>();
let source: EventSource | undefined;
let retry: ReturnType<typeof setTimeout> | undefined;

function connect() {
  const opened = new EventSource("/api/card-queue/events");
  source = opened;
  opened.onopen = () => listeners.forEach(l => l.open?.());
  opened.onmessage = event => {
    let reason = "";
    try { reason = String(JSON.parse(event.data).reason ?? ""); } catch { /* an unnamed change */ }
    listeners.forEach(l => l.change?.(reason));
  };
  opened.onerror = () => {
    const closed = opened.readyState === EventSource.CLOSED;
    listeners.forEach(l => l.error?.(closed));
    // EventSource gives up on a refused stream; open it again shortly.
    if (closed && source === opened) { source = undefined; retry = setTimeout(() => { retry = undefined; if (listeners.size) connect(); }, 3000); }
  };
}

/** Listens while subscribed; the stream is open while anything listens. */
export function subscribeLive(listener: Listener): () => void {
  listeners.add(listener);
  if (!source && !retry) connect();
  else if (source?.readyState === EventSource.OPEN) listener.open?.();
  return () => {
    listeners.delete(listener);
    if (!listeners.size) { source?.close(); source = undefined; clearTimeout(retry); retry = undefined; }
  };
}
