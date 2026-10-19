// A controllable EventSource for UI tests: the test decides what the stream delivers.
export function installEventSource() {
  const sources = [];
  class FakeEventSource {
    static CONNECTING = 0; static OPEN = 1; static CLOSED = 2;
    constructor(url) { this.url = url; this.readyState = 0; this.listeners = {}; this.closed = false; this.onerror = null; sources.push(this); }
    addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
    close() { this.closed = true; this.readyState = 2; }
    // The session stream carries every card: `id` names the card the event is for.
    emit(type, data, id) {
      const payload = id === undefined ? data : { id, data };
      if (!this.closed) for (const listener of this.listeners[type] || []) listener({ data: JSON.stringify(payload) });
    }
    // `refused` models a non-200 response: EventSource then gives up for good.
    fail(refused = false) { if (refused) this.readyState = 2; this.onerror?.({}); }
  }
  globalThis.EventSource = FakeEventSource;
  const open = () => sources.filter(source => !source.closed);
  return { sources, open, latest: () => open().at(-1) };
}
