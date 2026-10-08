// Session sync protocol, owner side.
//
// A session is published to every subscribed client either as a full
// `snapshot` or, on the streaming hot path, as an ordered `delta`:
//
//   {event:'snapshot', id, snapshot}                  snapshot.revision = R
//   {event:'delta', id, epoch, base, rev, ops}        applies only to revision `base`
//
// A client holding revision `base` of the same epoch applies `ops` and moves to
// `rev`. Any other client state is a gap, repaired by reading a full snapshot
// (the `read` action). Revisions only ever increase within an epoch; they may
// skip numbers, so only `base` ever has to match.
//
// Delta ops (the contract applied by src/lib/acp-delta.ts in the UI):
//   {op:'append', turn, block, text}   turn.blocks[block].text += text
//   {op:'block',  turn, block, value}  turn.blocks[block] = value (block <= length)
//   {op:'set',    key, value}          session[key] = value, key in SET_KEYS

export const SET_KEYS = ['context', 'commands'];

export function createSessionWire({ sessions: getSessions, clients, epoch, windowMs = 60 }) {
  const states = new Map();
  const stateOf = id => {
    let state = states.get(id);
    if (!state) states.set(id, state = { base: getSessions()[id]?.revision, full: false, ops: [], timer: undefined });
    return state;
  };
  // Every snapshot on the wire names its epoch and revision, or deltas could never follow it.
  const snapshotLine = id => {
    const session = getSessions()[id];
    session.ownerEpoch = epoch; session.revision ??= 0;
    return JSON.stringify({ event: 'snapshot', id, snapshot: session }) + '\n';
  };

  function flush(id) {
    const session = getSessions()[id], state = states.get(id);
    if (!session) { states.delete(id); return; }
    if (!state || (!state.full && !state.ops.length)) return;
    let full, delta;
    for (const client of clients) {
      if (!state.full && state.base !== undefined && client.revs?.get(id) === state.base) {
        delta ||= JSON.stringify({ event: 'delta', id, epoch, base: state.base, rev: session.revision, ops: state.ops }) + '\n';
        client.write(delta);
      } else {
        full ||= snapshotLine(id);
        client.write(full);
      }
      client.revs?.set(id, session.revision);
    }
    state.base = session.revision; state.full = false; state.ops = [];
  }
  function flushAll() { for (const id of [...states.keys()]) flush(id); }

  function arm(id) {
    const state = stateOf(id);
    state.timer = setTimeout(() => {
      if (state.full || state.ops.length) { flush(id); arm(id); }
      else state.timer = undefined;
    }, windowMs);
  }

  return {
    // `ops` marks a change that is fully described by those ops; anything else,
    // or `immediate`, goes out as a full snapshot without waiting for the window.
    publish(id, { immediate = false, ops } = {}) {
      const session = getSessions()[id];
      const state = stateOf(id); // before the bump: `base` is the revision clients already hold
      session.ownerEpoch = epoch; session.revision = (session.revision || 0) + 1;
      if (!immediate && ops) {
        if (!ops.length) return;
        if (!state.full) for (const op of ops) {
          const last = state.ops.at(-1);
          if (op.op === 'append' && last?.op === 'append' && last.turn === op.turn && last.block === op.block) last.text += op.text;
          else state.ops.push(op);
        }
      } else state.full = true;
      if (immediate) { clearTimeout(state.timer); state.timer = undefined; flush(id); return; }
      if (state.timer) return;
      flush(id); arm(id);
    },
    flushAll,
    attach(client) {
      client.revs = new Map();
      for (const [id, session] of Object.entries(getSessions())) { client.write(snapshotLine(id)); client.revs.set(id, session.revision); }
    },
  };
}
