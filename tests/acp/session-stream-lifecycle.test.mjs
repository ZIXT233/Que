import { installEventSource } from './event-source.mjs';
import { JSDOM } from 'jsdom';
import { build } from 'esbuild';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'sessionStorage']) globalThis[key] = dom.window[key];
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
globalThis.__streams = installEventSource();
const channels = [], NativeChannel = globalThis.MessageChannel;
globalThis.MessageChannel = class extends NativeChannel { constructor() { super(); channels.push(this); } };

const bundle = await build({
  stdin: { contents: `
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import assert from 'node:assert/strict';
import { AcpConversation } from './src/components/AcpConversation';
import { peekSessionSnapshot } from './src/lib/session-store';

export async function run() {
  const streams = globalThis.__streams, reads = [];
  const cards = ['a', 'b'].map(id => ({ id, harness: { kind: 'fixture' } }));
  const snapshot = (id, revision, text) => ({ ownerEpoch: 'owner', revision, state: 'attention', turns: [
    { id: 'turn', text: 'Question ' + id, state: 'completed', attachments: [], blocks: [{ type: 'text_delta', stream: 'message', text }] },
  ] });
  const states = { a: snapshot('a', 1, 'Answer A'), b: snapshot('b', 1, 'Answer B') };
  globalThis.fetch = async url => {
    const id = url.split('/').at(-1); reads.push(id);
    return { ok: true, json: async () => structuredClone(states[id]) };
  };
  const root = createRoot(document.getElementById('root'));
  const show = selected => act(async () => root.render(<>{cards.map((card, index) =>
    <section key={card.id} data-card={card.id}><AcpConversation card={card} active={index === selected} onResume={async () => {}} /></section>
  )}</>));
  const text = id => document.querySelector('[data-card="' + id + '"]').textContent;
  const push = (id, event, data) => act(async () => {
    streams.latest().emit(event, { id, data });
    await new Promise(resolve => setTimeout(resolve, 30));
  });
  try {
    await show(0);
    assert.deepEqual(reads, ['a'], 'a cold conversation still reads its state');
    const source = streams.latest();
    assert.equal(peekSessionSnapshot('a')?.revision, 1, 'a full read fills the shared cache even without a stream snapshot');
    await show(1);
    assert.deepEqual(reads, ['a', 'b'], 'each cold conversation is read once');
    assert.equal(peekSessionSnapshot('b')?.revision, 1);
    for (let i = 0; i < 8; i++) await show(i % 2);
    assert.equal(streams.sources.length, 1, 'card focus handoffs keep the existing shared stream');
    assert.equal(source.closed, false);
    assert.deepEqual(reads, ['a', 'b'], 'returning to HTTP-loaded conversations does not fetch full history again');
    assert.match(text('b'), /Answer B/, 'activation uses the shared cached snapshot');

    await push('a', 'delta', { epoch: 'owner', base: 1, rev: 2, ops: [{ op: 'append', turn: 'turn', block: 0, text: ' updated while away' }] });
    assert.equal(peekSessionSnapshot('a').revision, 2);
    await show(0);
    assert.match(text('a'), /Answer A updated while away/, 'returning reads the newer shared cache');
    assert.deepEqual(reads, ['a', 'b']);

    states.a = snapshot('a', 4, 'Recovered after gap');
    await push('a', 'delta', { epoch: 'owner', base: 3, rev: 4, ops: [] });
    assert.deepEqual(reads, ['a', 'b', 'a'], 'an actual revision gap still fetches a repair');
    assert.match(text('a'), /Recovered after gap/);
    assert.equal(peekSessionSnapshot('a').revision, 4, 'a repair also refreshes the shared cache');
    await show(1); await show(0);
    assert.match(text('a'), /Recovered after gap/);
    assert.deepEqual(reads, ['a', 'b', 'a']);
    await push('a', 'snapshot', states.a);
    await push('a', 'delta', { epoch: 'owner', base: 4, rev: 5, ops: [{ op: 'append', turn: 'turn', block: 0, text: ' and still streaming' }] });
    assert.match(text('a'), /Recovered after gap and still streaming/, 'a stream continues after HTTP cache repair');
    await act(async () => root.unmount());
    assert.equal(source.closed, true, 'the shared stream closes once the last view really leaves');
    console.log('PASS: focus handoffs reuse one stream and cached history; inactive deltas are retained; real gaps still repair; final unmount closes');
  } finally {
    await act(async () => root.unmount());
  }
}
`, loader: 'tsx', resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'esm', jsx: 'automatic', loader: { '.css': 'empty' },
  plugins: [{ name: 'fixtures', setup(b) {
    b.onLoad({ filter: /components\/chat\/Composer.tsx$/ }, () => ({ contents: 'export function Composer(){return null}', loader: 'tsx' }));
    b.onLoad({ filter: /hooks\/useI18n.tsx$/ }, () => ({ contents: 'export function useI18n(){return {t:key=>key}}', loader: 'js' }));
  } }],
  banner: { js: "import {createRequire} from 'node:module';const require=createRequire(import.meta.url);" },
});
const dir = await mkdtemp(join(tmpdir(), 'queacp-stream-lifecycle-'));
try {
  const entry = join(dir, 'test.mjs');
  await writeFile(entry, bundle.outputFiles[0].text);
  await (await import(pathToFileURL(entry))).run();
} finally {
  dom.window.close();
  for (const channel of channels) { channel.port1.close(); channel.port2.close(); }
  await rm(dir, { recursive: true, force: true });
}
