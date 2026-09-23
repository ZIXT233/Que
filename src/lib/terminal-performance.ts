// Counts only: no terminal text or input is retained. Times are milliseconds;
// chars are UTF-16 units, while offsets come from the backend's byte cursor.
type Ticket = { at: number; chars: number; offset: number; started?: number };
const fresh = () => ({
  receivedChunks: 0, receivedChars: 0, parsedChars: 0,
  replayChunks: 0, replayChars: 0, resets: 0,
  pendingPeakChars: 0, queueMaxMs: 0, writeMaxMs: 0, writeTotalMs: 0,
  prepareMaxMs: 0, jsonMaxMs: 0, renderCalls: 0,
  renderCpuTotalMs: 0, renderCpuMaxMs: 0, clearScreen: 0, clearScrollback: 0,
});

export class TerminalPerformanceProbe {
  private stats = fresh();
  private pending = new Set<Ticket>();
  private pendingChars = 0;
  private parsedOffset?: number;
  private receivedOffset?: number;
  private history: Record<string, unknown>[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private windowAt = performance.now();
  private dueAt = 0;
  private renderer?: object;
  private restoreRenderer?: () => void;
  private disposed = false;

  constructor(
    private readonly context: () => Record<string, unknown>,
    private readonly report: (summary: Record<string, unknown>) => void,
  ) {}

  private schedule() {
    if (this.timer !== undefined || this.disposed) return;
    this.windowAt = performance.now();
    this.dueAt = this.windowAt + 5000;
    this.timer = setTimeout(() => this.flush(), 5000);
  }

  enqueue(chars: number, offset: number, reset?: boolean, jsonMs = 0): Ticket {
    const ticket = { at: performance.now(), chars, offset };
    this.pending.add(ticket);
    this.pendingChars += chars;
    this.receivedOffset = offset;
    this.stats.receivedChunks++;
    this.stats.receivedChars += chars;
    this.stats.jsonMaxMs = Math.max(this.stats.jsonMaxMs, jsonMs);
    this.stats.pendingPeakChars = Math.max(this.stats.pendingPeakChars, this.pendingChars);
    if (reset !== undefined) { this.stats.replayChunks++; this.stats.replayChars += chars; }
    if (reset) this.stats.resets++;
    this.schedule();
    return ticket;
  }

  start(ticket: Ticket) {
    ticket.started = performance.now();
    this.stats.queueMaxMs = Math.max(this.stats.queueMaxMs, ticket.started - ticket.at);
  }

  prepared(ticket: Ticket, ms: number) {
    this.stats.prepareMaxMs = Math.max(this.stats.prepareMaxMs, ms);
    ticket.started = performance.now();
  }

  complete(ticket: Ticket, countWriteTiming = true) {
    if (this.disposed || !this.pending.delete(ticket)) return;
    this.pendingChars -= ticket.chars;
    const ms = performance.now() - (ticket.started ?? ticket.at);
    if (countWriteTiming) {
      this.stats.writeMaxMs = Math.max(this.stats.writeMaxMs, ms);
      this.stats.writeTotalMs += ms;
    }
    this.stats.parsedChars += ticket.chars;
    this.parsedOffset = ticket.offset;
    this.schedule();
  }

  clear(mode: number) {
    if (mode === 2) this.stats.clearScreen++;
    if (mode === 3) this.stats.clearScrollback++;
  }

  // xterm has no public draw-duration event. Guard this optional timing hook;
  // a different internal layout simply makes rendererTiming=false. This times
  // the JS renderRows call, not asynchronous GPU completion or screen scanout.
  watchRenderer(terminal: unknown) {
    const renderer = (terminal as { _core?: { _renderService?: { _renderer?: { value?: {
      renderRows: (start: number, end: number) => void;
    } } } } })?._core?._renderService?._renderer?.value;
    if (renderer === this.renderer) return;
    this.restoreRenderer?.();
    this.restoreRenderer = undefined;
    this.renderer = undefined;
    if (!renderer || typeof renderer.renderRows !== "function") return;
    const original = renderer.renderRows;
    const probe = this;
    function timed(this: typeof renderer, start: number, end: number) {
      const at = performance.now();
      try { return original.call(this, start, end); }
      finally {
        if (!probe.disposed && (probe.timer !== undefined || probe.pending.size > 0)) {
          const ms = performance.now() - at;
          probe.stats.renderCalls++;
          probe.stats.renderCpuTotalMs += ms;
          probe.stats.renderCpuMaxMs = Math.max(probe.stats.renderCpuMaxMs, ms);
        }
      }
    }
    try {
      renderer.renderRows = timed;
      this.renderer = renderer;
      this.restoreRenderer = () => { if (renderer.renderRows === timed) renderer.renderRows = original; };
    } catch { /* Diagnostics must not prevent renderer startup. */ }
  }

  snapshot() {
    const first = this.pending.values().next().value as Ticket | undefined;
    return {
      receivedOffset: this.receivedOffset, parsedOffset: this.parsedOffset,
      pendingChunks: this.pending.size, pendingChars: this.pendingChars,
      oldestPendingMs: first ? Math.round(performance.now() - first.at) : 0,
      rendererTiming: !!this.renderer,
      current: { ...this.stats }, recent: [...this.history],
    };
  }

  private flush() {
    this.timer = undefined;
    if (this.disposed) return;
    const now = performance.now();
    const { current, recent: _recent, ...state } = this.snapshot();
    const rounded = Object.fromEntries(Object.entries(current).map(([key, value]) => [key, Math.round(value * 10) / 10]));
    const summary = { at: Date.now(), windowMs: Math.round(now - this.windowAt),
      timerLateMs: Math.max(0, Math.round(now - this.dueAt)), ...this.context(), ...state, ...rounded };
    this.history.push(summary);
    if (this.history.length > 12) this.history.shift();
    this.stats = fresh();
    this.stats.pendingPeakChars = this.pendingChars;
    this.report(summary);
    if (this.pending.size) this.schedule();
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
    this.restoreRenderer?.();
    this.pending.clear();
  }
}
