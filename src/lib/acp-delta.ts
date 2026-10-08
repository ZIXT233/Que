// Applies one session delta (see runtime/session-wire.mjs for the protocol).
// The golden vectors in tests/acp/delta-vectors.json pin this behaviour; the
// Rust cache in src-tauri/src/acp.rs implements the same contract.

export const SET_KEYS = ['context', 'commands'] as const;
export type DeltaOp =
  | { op: 'append'; turn: string; block: number; text: string }
  | { op: 'block'; turn: string; block: number; value: unknown }
  | { op: 'set'; key: (typeof SET_KEYS)[number]; value: unknown };
export type Delta = { epoch: string; base: number; rev: number; ops: DeltaOp[] };
type Versioned = { ownerEpoch?: string; revision?: number; turns: { id: string; blocks: any[] }[] };

/**
 * Returns the next snapshot, `'stale'` when the delta is already included, or
 * `'gap'` when it cannot be applied and a full snapshot must be fetched.
 * Only the touched turns and blocks are copied; everything else keeps its identity.
 */
export function applyDelta<S extends Versioned>(snapshot: S, delta: Delta): S | 'stale' | 'gap' {
  if (snapshot.ownerEpoch !== delta.epoch || typeof snapshot.revision !== 'number') return 'gap';
  if (delta.rev <= snapshot.revision) return 'stale';
  if (delta.base !== snapshot.revision) return 'gap';
  let turns = snapshot.turns;
  const copied = new Set<string>();
  const sets: Record<string, unknown> = {};
  for (const op of delta.ops) {
    if (op.op === 'set') {
      if (!SET_KEYS.includes(op.key)) return 'gap';
      sets[op.key] = op.value;
      continue;
    }
    const at = turns.findIndex(turn => turn.id === op.turn);
    if (at < 0 || !Number.isInteger(op.block) || op.block < 0) return 'gap';
    if (turns === snapshot.turns) turns = [...turns];
    if (!copied.has(op.turn)) { turns[at] = { ...turns[at], blocks: [...turns[at].blocks] }; copied.add(op.turn); }
    const blocks = turns[at].blocks;
    if (op.op === 'block') {
      if (op.block > blocks.length) return 'gap';
      blocks[op.block] = op.value;
    } else if (op.op === 'append') {
      const block = blocks[op.block];
      if (!block || typeof block.text !== 'string' || typeof op.text !== 'string') return 'gap';
      blocks[op.block] = { ...block, text: block.text + op.text };
    } else return 'gap';
  }
  return { ...snapshot, ...sets, turns, revision: delta.rev };
}

export type StreamEvent<S> = { event: 'snapshot'; data: S } | { event: 'delta'; data: Delta };

/**
 * Fold a batch of stream events into the current snapshot. `gap` means a delta
 * could not be applied and the caller must fetch a full snapshot; a later
 * snapshot in the same batch repairs it. An older snapshot of the same owner
 * never replaces a newer state.
 */
export function foldEvents<S extends Versioned>(previous: S | undefined, events: StreamEvent<S>[]): { snapshot: S | undefined; gap: boolean } {
  let snapshot = previous, gap = false;
  for (const { event, data } of events) {
    if (event === 'snapshot') {
      const older = snapshot?.ownerEpoch && data.ownerEpoch === snapshot.ownerEpoch && (data.revision ?? 0) < (snapshot.revision ?? 0);
      if (!older) { snapshot = data; gap = false; }
    } else if (!snapshot) gap = true;
    else {
      const next = applyDelta(snapshot, data);
      if (next === 'gap') gap = true; else if (next !== 'stale') snapshot = next;
    }
  }
  return { snapshot, gap };
}
