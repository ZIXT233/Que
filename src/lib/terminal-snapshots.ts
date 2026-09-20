interface TerminalSnapshot {
  output: string;
  offset: number;
  cols: number;
  rows: number;
}

const MAX_SNAPSHOTS = 48;
// UTF-16 payload budget; Map/object overhead is not included.
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const snapshots = new Map<string, TerminalSnapshot>();
let totalBytes = 0;

/** Preserve a fully parsed xterm state and its matching SSE cursor. */
export function saveTerminalSnapshot(id: string, snapshot: TerminalSnapshot) {
  dropTerminalSnapshot(id);
  const bytes = snapshot.output.length * 2;
  if (bytes > MAX_TOTAL_BYTES) return;
  snapshots.set(id, snapshot);
  totalBytes += bytes;
  while (snapshots.size > MAX_SNAPSHOTS || totalBytes > MAX_TOTAL_BYTES) {
    const oldest = snapshots.keys().next().value;
    if (oldest === undefined) break;
    dropTerminalSnapshot(oldest);
  }
}

export function getTerminalSnapshot(id: string): TerminalSnapshot | undefined {
  const snapshot = snapshots.get(id);
  if (snapshot) {
    snapshots.delete(id);
    snapshots.set(id, snapshot);
  }
  return snapshot;
}

export function dropTerminalSnapshot(id: string) {
  const snapshot = snapshots.get(id);
  if (snapshot) totalBytes -= snapshot.output.length * 2;
  snapshots.delete(id);
}
