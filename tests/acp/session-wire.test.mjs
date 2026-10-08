import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// The TypeScript applier is the one the UI uses; bundle it for the Node test.
const dir = mkdtempSync(join(tmpdir(), 'flat-wire-'));
const out = await build({ entryPoints: ['src/lib/acp-delta.ts'], bundle: true, write: false, format: 'esm', platform: 'node' });
writeFileSync(join(dir, 'acp-delta.mjs'), out.outputFiles[0].text);
const { applyDelta } = await import(pathToFileURL(join(dir, 'acp-delta.mjs')));
const { createSessionWire } = await import('../../runtime/session-wire.mjs');
test.after(() => rmSync(dir, { recursive: true, force: true }));

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const client = () => ({ lines: [], write(line) { this.lines.push(JSON.parse(line)); } });
const fixture = () => {
  const sessions = { a: { id: 'a', revision: 0, state: 'working', turns: [{ id: 't', blocks: [{ type: 'text_delta', stream: 'message', text: '' }] }] } };
  const clients = new Set();
  return { sessions, clients, wire: createSessionWire({ sessions: () => sessions, clients, epoch: 'E', windowMs: 20 }) };
};
const append = (sessions, wire, text) => {
  sessions.a.turns[0].blocks[0].text += text;
  wire.publish('a', { ops: [{ op: 'append', turn: 't', block: 0, text }] });
};
// What a client does with the stream: snapshots replace, deltas apply or demand a resync.
const replay = lines => lines.reduce((state, line) => {
  if (line.event === 'snapshot') return line.snapshot;
  const next = applyDelta(state, line);
  assert.notEqual(next, 'gap', 'the stream never produces a gap for an attached client');
  return next === 'stale' ? state : next;
}, undefined);

test('delta vectors are applied identically by the UI applier', () => {
  for (const vector of JSON.parse(readFileSync('tests/acp/delta-vectors.json', 'utf8'))) {
    const before = structuredClone(vector.before);
    assert.deepEqual(applyDelta(before, vector.delta), vector.after, vector.name);
    assert.deepEqual(before, vector.before, `${vector.name}: the input is never mutated`);
  }
});

test('streaming collapses into few deltas that rebuild the exact session', async () => {
  const { sessions, clients, wire } = fixture();
  const c = client(); clients.add(c); wire.attach(c);
  for (let i = 0; i < 200; i++) append(sessions, wire, `w${i} `);
  await sleep(80);
  const events = c.lines.slice(1);
  assert.ok(events.length <= 4, `200 appends produced ${events.length} events`);
  assert.ok(events.every(event => event.event === 'delta'), 'streaming text never resends the conversation');
  assert.equal(events.at(-1).rev, sessions.a.revision);
  assert.deepEqual(replay(c.lines), JSON.parse(JSON.stringify(sessions.a)));
});

test('every state change is a full snapshot and supersedes pending deltas', async () => {
  const { sessions, clients, wire } = fixture();
  const c = client(); clients.add(c); wire.attach(c);
  append(sessions, wire, 'a'); append(sessions, wire, 'b'); append(sessions, wire, 'c');
  sessions.a.state = 'attention'; wire.publish('a', { immediate: true });
  const events = c.lines.slice(1);
  assert.equal(events.at(-1).event, 'snapshot');
  assert.equal(events.at(-1).snapshot.state, 'attention');
  await sleep(60);
  assert.equal(c.lines.length, 1 + events.length, 'nothing is sent twice after the snapshot');
  assert.deepEqual(replay(c.lines), JSON.parse(JSON.stringify(sessions.a)));
});

test('a client that joins mid-stream or lost sync gets a snapshot, never a delta it cannot apply', async () => {
  const { sessions, clients, wire } = fixture();
  const early = client(); clients.add(early); wire.attach(early);
  append(sessions, wire, 'one ');
  await sleep(40);
  const late = client(); clients.add(late); wire.attach(late);
  append(sessions, wire, 'two ');
  await sleep(40);
  assert.deepEqual(replay(late.lines), JSON.parse(JSON.stringify(sessions.a)));
  assert.deepEqual(replay(early.lines), JSON.parse(JSON.stringify(sessions.a)));
  // A client attached while ops are still pending must not receive an overlapping delta.
  append(sessions, wire, 'three ');
  append(sessions, wire, 'four ');
  const joiner = client(); clients.add(joiner); wire.attach(joiner);
  await sleep(60);
  assert.ok(joiner.lines.slice(1).every(event => event.event === 'snapshot'));
  assert.deepEqual(replay(joiner.lines), JSON.parse(JSON.stringify(sessions.a)));
  // Explicit repair.
  const stale = client(); clients.add(stale); wire.attach(stale);
  sessions.a.turns[0].blocks[0].text = 'rewritten'; wire.resync(stale, 'a');
  assert.equal(stale.lines.at(-1).snapshot.turns[0].blocks[0].text, 'rewritten');
});

test('flushAll delivers pending deltas before an RPC response that carries the session', async () => {
  const { sessions, clients, wire } = fixture();
  const c = client(); clients.add(c); wire.attach(c);
  append(sessions, wire, 'lead ');
  append(sessions, wire, 'pending ');
  const before = c.lines.length;
  wire.flushAll();
  assert.equal(c.lines.length, before + 1);
  assert.equal(c.lines.at(-1).rev, sessions.a.revision, 'the stream is current when the response is written');
});
