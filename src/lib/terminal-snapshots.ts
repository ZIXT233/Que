interface TerminalSnapshot {
  output: string;
  offset: number;
  touchedAt: number;
}

const MAX_SNAPSHOTS = 48;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const snapshots = new Map<string, TerminalSnapshot>();

function trim() {
  let total = [...snapshots.values()].reduce((sum, snapshot) => sum + snapshot.output.length, 0);
  while (snapshots.size > MAX_SNAPSHOTS || total > MAX_TOTAL_BYTES) {
    const oldest = [...snapshots.entries()].sort((a, b) => a[1].touchedAt - b[1].touchedAt)[0];
    if (!oldest) return;
    snapshots.delete(oldest[0]);
    total -= oldest[1].output.length;
  }
}

/** Preserve xterm's rendered state and SSE cursor across card DOM culling. */
export function saveTerminalSnapshot(id: string, output: string, offset: number | undefined) {
  if (offset === undefined || !output) return;
  snapshots.set(id, { output, offset, touchedAt: Date.now() });
  trim();
}

export function getTerminalSnapshot(id: string): TerminalSnapshot | undefined {
  const snapshot = snapshots.get(id);
  if (snapshot) snapshot.touchedAt = Date.now();
  return snapshot;
}

export function dropTerminalSnapshot(id: string) {
  snapshots.delete(id);
}
