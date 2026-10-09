import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sessionHistory, projectRecord, messageHeader, parseMessage, mapLimit } from '../../runtime/session-history.mjs';

const record = (id, cwd, lastUsedAt, extra = {}) => ({ acpxRecordId: id, cwd, title: `title ${id}`, lastUsedAt, agentCommand: 'agent', messages: [{ big: 'x'.repeat(1000) }], ...extra });

test('history listing re-reads only the transcripts that changed', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'queacp-history-'));
  try {
    await mkdir(path.join(dir, 'sessions'));
    const write = async (id, value, mtime) => { const file = path.join(dir, 'sessions', `${encodeURIComponent(id)}.json`); await writeFile(file, JSON.stringify(value)); if (mtime) await utimes(file, mtime, mtime); };
    await write('a', record('a', '/work', '2026-01-01'));
    await write('b', record('b', '/work', '2026-03-01'));
    await write('c', record('c', '/elsewhere', '2026-02-01'));
    await write('bad%', { ignored: true });
    let loads = [];
    const store = { async load(id) { loads.push(id); return JSON.parse(await (await import('node:fs/promises')).readFile(path.join(dir, 'sessions', `${encodeURIComponent(id)}.json`), 'utf8')); } };
    const list = sessionHistory(dir, store);

    const first = await list('/work');
    assert.deepEqual(first.map(r => r.acpxRecordId), ['b', 'a'], 'filtered by workspace, newest first');
    assert.ok(!('messages' in first[0]), 'a summary never carries the transcript');
    assert.equal(loads.length, 4);

    loads = [];
    assert.deepEqual((await list('/work')).map(r => r.acpxRecordId), ['b', 'a']);
    assert.deepEqual((await list()).map(r => r.acpxRecordId), ['b', 'c', 'a']);
    assert.equal(loads.length, 0, 'unchanged transcripts are not read again');

    await write('a', record('a', '/work', '2026-05-01', { title: 'renamed' }), new Date(Date.now() + 5000));
    const updated = await list('/work');
    assert.deepEqual(loads, ['a'], 'only the changed file is re-read');
    assert.deepEqual(updated.map(r => [r.acpxRecordId, r.title]), [['a', 'renamed'], ['b', 'title b']]);

    await rm(path.join(dir, 'sessions', 'b.json'));
    loads = [];
    assert.deepEqual((await list('/work')).map(r => r.acpxRecordId), ['a'], 'a deleted transcript disappears');
    assert.equal(loads.length, 0);
    assert.deepEqual(await sessionHistory(path.join(dir, 'missing'), store)(), [], 'no sessions directory is an empty list');
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

const user = (id, text, extra = []) => ({ User: { id, content: [{ Text: text }, ...extra] } });
const agent = text => ({ Agent: { content: [{ Text: text }], tool_results: {} } });

test('who sent a message survives in the message itself', () => {
  const sender = { cardId: 'card-b', name: 'Backend "api"' };
  assert.deepEqual(parseMessage(messageHeader({ sender }) + 'pull and restart'),
    { text: 'pull and restart', source: 'agent', sender: { cardId: 'card-b', name: "Backend 'api'" } });
  assert.deepEqual(parseMessage(messageHeader({ notification: true }) + 'status data'), { text: 'status data', source: 'event' });
  assert.deepEqual(parseMessage('[Que: not really a header]\n\nhi'), { text: '[Que: not really a header]\n\nhi', source: 'user' });
  assert.equal(messageHeader({}), '');
});

test('the acpx record projects to one turn per user message', () => {
  const turns = projectRecord({ messages: [
    agent('greeting before any prompt'),
    'Resume',
    user('m1', messageHeader({ sender: { cardId: 'b', name: 'B' } }) + 'do it', [{ Image: { mime_type: 'image/png', source: 'AAA' } }]),
    { Agent: { content: [{ Thinking: { text: 'hmm' } }, { ToolUse: { id: 't1', name: 'Read', input: { path: 'a' }, is_input_complete: true } }, { Text: 'done' }],
      tool_results: { t1: { output: 'contents', is_error: false } } } },
    user('m2', 'thanks'),
  ] });
  assert.equal(turns.length, 3);
  assert.equal(turns[0].text, '');
  assert.deepEqual(turns[1].sender, { cardId: 'b', name: 'B' });
  assert.equal(turns[1].text, 'do it');
  assert.deepEqual(turns[1].attachments, [{ mediaType: 'image/png', data: 'AAA' }]);
  assert.deepEqual(turns[1].blocks.map(b => [b.type, b.stream ?? b.status]), [['text_delta', 'thought'], ['tool_call', 'completed'], ['text_delta', 'message']]);
  assert.equal(turns[1].blocks[1].rawOutput, 'contents');
  assert.ok(turns.every(t => t.state === 'history'));
  assert.deepEqual(projectRecord(undefined), []);
});

test('a very long transcript projects quickly', () => {
  const messages = [];
  for (let i = 0; i < 4000; i++) messages.push(user(`m${i}`, `q${i}`), agent(`a${i}`));
  const started = performance.now();
  assert.equal(projectRecord({ messages }).length, 4000);
  assert.ok(performance.now() - started < 1500);
});
