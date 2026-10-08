import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sessionHistory, projectRecord, preserveToolContent, mapLimit } from '../../runtime/session-history.mjs';

const record = (id, cwd, lastUsedAt, extra = {}) => ({ acpxRecordId: id, cwd, title: `title ${id}`, lastUsedAt, agentCommand: 'agent', messages: [{ big: 'x'.repeat(1000) }], ...extra });

test('history listing re-reads only the transcripts that changed', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'flat-history-'));
  try {
    await mkdir(path.join(dir, 'sessions'));
    const write = async (id, value, mtime) => { const file = path.join(dir, 'sessions', `${encodeURIComponent(id)}.json`); await writeFile(file, JSON.stringify(value)); if (mtime) await utimes(file, mtime, mtime); };
    await write('a', record('a', '/work', '2026-01-01'));
    await write('b', record('b', '/work', '2026-03-01'));
    await write('c', record('c', '/elsewhere', '2026-02-01'));
    await write('bad%', { ignored: true });
    let loads = [];
    const store = { async load(id) { loads.push(id); return JSON.parse(await (await import('node:fs/promises')).readFile(path.join(dir, 'sessions', `${encodeURIComponent(id)}.json`), 'utf8')); } };
    const history = sessionHistory(dir, { store });

    const first = await history.list('/work');
    assert.deepEqual(first.map(r => r.acpxRecordId), ['b', 'a'], 'filtered by workspace, newest first');
    assert.ok(!('messages' in first[0]), 'a summary never carries the transcript');
    assert.equal(loads.length, 4);

    loads = [];
    assert.deepEqual((await history.list('/work')).map(r => r.acpxRecordId), ['b', 'a']);
    assert.deepEqual((await history.list()).map(r => r.acpxRecordId), ['b', 'c', 'a']);
    assert.equal(loads.length, 0, 'unchanged transcripts are not read again');

    await write('a', record('a', '/work', '2026-05-01', { title: 'renamed' }), new Date(Date.now() + 5000));
    const updated = await history.list('/work');
    assert.deepEqual(loads, ['a'], 'only the changed file is re-read');
    assert.deepEqual(updated.map(r => [r.acpxRecordId, r.title]), [['a', 'renamed'], ['b', 'title b']]);

    await rm(path.join(dir, 'sessions', 'b.json'));
    loads = [];
    assert.deepEqual((await history.list('/work')).map(r => r.acpxRecordId), ['a'], 'a deleted transcript disappears');
    assert.equal(loads.length, 0);
    assert.deepEqual(await sessionHistory(path.join(dir, 'missing'), { store }).list(), [], 'no sessions directory is an empty list');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('mapLimit keeps order and never exceeds its concurrency', async () => {
  let running = 0, peak = 0;
  const out = await mapLimit([5, 1, 4, 2, 3, 0], 2, async (n, index) => {
    running++; peak = Math.max(peak, running);
    await new Promise(resolve => setTimeout(resolve, n * 5));
    running--; return `${index}:${n}`;
  });
  assert.deepEqual(out, ['0:5', '1:1', '2:4', '3:2', '4:3', '5:0']);
  assert.equal(peak, 2);
  assert.deepEqual(await mapLimit([], 4, async () => 1), []);
  await assert.rejects(mapLimit([1, 2], 2, async n => { if (n === 2) throw Error('boom'); }), /boom/);
});

const user = (id, text) => ({ User: { id, content: [{ Text: text }] } });
const agent = text => ({ Agent: { content: [{ Text: text }], tool_results: {} } });

test('projecting a transcript matches receipts by message and keeps unmatched ones', () => {
  const messages = [user('m1', 'one'), agent('A1'), user('m2', 'two'), agent('A2')];
  const receipts = [
    { id: 'req-1', messageId: 'm1', state: 'completed', source: 'user' },
    { id: 'req-1-dup', messageId: 'm1', state: 'failed' },
    { id: 'req-pending', state: 'queued', pending: { text: 'never reached acpx', attachments: [] } },
    { id: 'req-pending', state: 'queued', pending: { text: 'duplicate id', attachments: [] } },
  ];
  const turns = projectRecord({ messages }, receipts);
  assert.deepEqual(turns.map(t => t.id), ['req-1', 'm2', 'req-1-dup', 'req-pending'], 'the first receipt for a message wins, others are kept once by id');
  assert.equal(turns[0].state, 'completed');
  assert.equal(turns[1].state, 'history');
  assert.equal(turns[2].state, 'failed');
  assert.equal(turns[3].text, 'never reached acpx');
  assert.equal(turns[3].state, 'unknown');
});

test('a very long transcript projects quickly', () => {
  const messages = [], receipts = [];
  for (let i = 0; i < 4000; i++) { messages.push(user(`m${i}`, `q${i}`), agent(`a${i}`)); receipts.push({ id: `r${i}`, messageId: `m${i}`, state: 'completed' }); }
  const started = performance.now();
  const turns = projectRecord({ messages }, receipts);
  assert.equal(turns.length, 4000);
  assert.ok(performance.now() - started < 1500, 'receipt matching is not quadratic');
});

test('a finished tool call is serialized into the record once', () => {
  let serialized = 0;
  const content = { toJSON() { serialized++; return [{ type: 'text', text: 'ok' }]; } };
  const record = { messages: [user('m1', 'go'), { Agent: { content: [], tool_results: { t1: {}, t2: {} } } }] };
  const turns = [{ messageId: 'm1', blocks: [
    { type: 'tool_call', toolCallId: 't1', status: 'completed', content },
    { type: 'tool_call', toolCallId: 't2', status: 'in_progress', content },
  ] }];
  preserveToolContent(record, turns);
  assert.equal(serialized, 2);
  assert.equal(record.messages[1].Agent.tool_results.t1.flat_status, 'completed');
  preserveToolContent(record, turns);
  assert.equal(serialized, 3, 'only the running call is serialized again');
  turns[0].blocks[1].status = 'completed';
  preserveToolContent(record, turns);
  assert.equal(serialized, 4, 'it is serialized once more when it finishes');
  preserveToolContent(record, turns);
  assert.equal(serialized, 4);
  assert.equal(record.messages[1].Agent.tool_results.t2.flat_status, 'completed');
  assert.deepEqual(JSON.parse(record.messages[1].Agent.tool_results.t2.flat_content_json), [{ type: 'text', text: 'ok' }]);
});
