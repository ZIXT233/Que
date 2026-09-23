/** Coalesce waiting live output without crossing reset/replay boundaries. */
export class TerminalOutputQueue<T extends { data: string; reset?: boolean }> {
  private pending: T[] = [];
  private writing = false;
  private disposed = false;
  constructor(private readonly write: (batch: T[], done: () => void) => void,
    private readonly maxChars = 64 * 1024) {}

  enqueue(item: T) {
    if (this.disposed) return;
    this.pending.push(item);
    this.drain();
  }

  private drain() {
    if (this.writing || this.disposed || !this.pending.length) return;
    const batch = [this.pending.shift()!];
    let chars = batch[0].data.length;
    // Catch-up/reset writes stay isolated so terminal replies retain their policy.
    while (batch[0].reset === undefined && this.pending.length &&
      this.pending[0].reset === undefined && chars + this.pending[0].data.length <= this.maxChars) {
      const next = this.pending.shift()!;
      batch.push(next);
      chars += next.data.length;
    }
    this.writing = true;
    this.write(batch, () => {
      this.writing = false;
      this.drain();
    });
  }

  dispose() { this.disposed = true; this.pending = []; }
}
