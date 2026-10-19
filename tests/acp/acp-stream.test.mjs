import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';

const binary = process.env.QUEACP_HEADLESS_TEST_BINARY;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (check, what, ms = 60000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) { const value = await check(); if (value) return value; }
  throw Error(`timed out waiting for ${what}`);
};
// Minimal EventSource: collects `event:`/`data:` blocks from the HTTP stream.
async function subscribe(url) {
  const controller = new AbortController(), events = [];
  const response = await fetch(url, { signal: controller.signal });
  assert.equal(response.status, 200);
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '';
  const finished = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (let end; (end = buffer.indexOf('\n\n')) >= 0;) {
          const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          let event = 'message', data = '';
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) data += line.slice(5).trimStart();
          }
          if (data) events.push({ event, data: JSON.parse(data) });
        }
      }
    } catch (error) { if (error.name !== 'AbortError') throw error; }
  })();
  return { events, close: () => { controller.abort(); return finished; } };
}

test('a conversation stream rebuilds the exact server state from a snapshot and a few deltas', { skip: !binary, timeout: 120000 }, async () => {
  const bundled = await build({ entryPoints: ['src/lib/acp-delta.ts'], bundle: true, write: false, format: 'esm', platform: 'node' });
  const { applyDelta } = await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64'));
  const root = await mkdtemp(path.join(tmpdir(), 'queacp-acp-stream-'));
  const child = spawn(binary, [root], { env: { ...process.env, QUE_BIN_DIR: path.resolve('src-tauri/resources/bin') }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', d => stderr += d);
  const lines = readline.createInterface({ input: child.stdout });
  const address = new Promise((resolve, reject) => { lines.on('line', line => { try { const v = JSON.parse(line); if (v.base) resolve(v); } catch {} }); child.once('exit', () => reject(Error(stderr))); });
  let card;
  let ownerPid, stream, second;
  try {
    const { base, token: apiToken } = await address;
    const request = async (route, body) => {
      const response = await fetch(base + route, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'x-que-token': apiToken }, body: body ? JSON.stringify(body) : undefined });
      const data = await response.json(); if (!response.ok) throw Error(data.error || JSON.stringify(data)); return data;
    };
    const acpRoot = path.join(root, 'que', 'acp'); await mkdir(acpRoot, { recursive: true });
    await writeFile(path.join(acpRoot, 'agents.json'), JSON.stringify({ codex: [process.execPath, path.resolve('tests/acp/agent.mjs')] }));
    // No Butler card yet: the button gives none, and the card is made with its agent.
    assert.equal((await request('/api/card-queue', { action: 'butler_open' })).butlerId, null);
    card = (await request('/api/card-queue', { action: 'create', workspaceId: 'queacp-butler', kind: 'codex' })).createdId;
    await request('/api/card-queue', { action: 'harness_resume', id: card });

    stream = await subscribe(`${base}/api/acp/${card}/events?token=${apiToken}`);
    await until(() => stream.events.length, 'the initial snapshot');
    ownerPid = Number(await readFile(path.join(acpRoot, 'owner.pid'), 'utf8'));
    assert.equal(stream.events[0].event, 'snapshot', 'a subscription starts from the current state');

    await request('/api/acp/' + card, { action: 'send', requestId: 'stream-1', text: 'stream-many' });
    // The owner still publishes once after a turn is marked completed: wait until the
    // server state and the stream agree on the same, final revision.
    const revisionOf = ({ data }) => data.rev ?? data.revision; // a delta carries `rev`, a snapshot is the session itself
    const finalState = await until(async () => {
      const s = await request('/api/acp/' + card);
      return s.turns.at(-1)?.state === 'completed' && revisionOf(stream.events.at(-1)) === s.revision && s;
    }, 'the turn to complete and the stream to catch up');

    const deltas = stream.events.filter(e => e.event === 'delta'), snapshots = stream.events.filter(e => e.event === 'snapshot');
    console.log(`# 3000 tokens -> ${deltas.length} deltas, ${snapshots.length} snapshots`);
    assert.ok(deltas.length > 0 && deltas.length < 300, `3000 tokens produced ${deltas.length} deltas`);
    assert.ok(snapshots.length < 30, `only state changes send snapshots, got ${snapshots.length}`);

    let state;
    for (const { event, data } of stream.events) {
      if (event === 'snapshot') { if (!state || data.revision >= state.revision) state = data; continue; }
      const next = applyDelta(state, data);
      assert.notEqual(next, 'gap', 'the stream never leaves the UI with a gap');
      if (next !== 'stale') state = next;
    }
    const streamed = state.turns.at(-1).blocks.filter(b => b.type === 'text_delta').map(b => b.text).join('');
    assert.ok(streamed.includes('token0 ') && streamed.includes('token2999 '));
    assert.deepEqual(state.turns, finalState.turns, 'replaying the stream equals the server state');
    assert.equal(state.revision, finalState.revision);

    // A late subscriber (reload, card moved) starts from the full current state.
    second = await subscribe(`${base}/api/acp/${card}/events?token=${apiToken}`);
    await until(() => second.events.length, 'a second snapshot');
    assert.equal(second.events[0].event, 'snapshot');
    assert.deepEqual(second.events[0].data.turns, finalState.turns);
  } finally {
    await stream?.close(); await second?.close();
    child.stdin.end(); await new Promise(resolve => { if (child.exitCode !== null) return resolve(); child.once('exit', resolve); setTimeout(() => child.kill(), 3000).unref(); });
    if (ownerPid) try { process.kill(ownerPid); } catch {}
    for (let i = 0; i < 120 && existsSync(path.join(root, 'que', 'acp', 'owner.pid')); i++) await sleep(50);
    await rm(root, { recursive: true, force: true });
  }
});
