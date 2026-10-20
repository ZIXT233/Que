import { JSDOM } from 'jsdom';
import { build } from 'esbuild';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent']) {
  globalThis[key] = dom.window[key];
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
window.matchMedia = () => ({ matches: false });
Object.defineProperty(HTMLElement.prototype, 'clientWidth', { get() { return 900; } });
// Supply scrollend explicitly: this is a component regression test, not a
// simulation of the browser's scrolling physics or frame rate.
Object.defineProperty(HTMLElement.prototype, 'onscrollend', { configurable: true, value: null });
const scrollCalls = [];
HTMLElement.prototype.scrollTo = function (options) {
  scrollCalls.push(options);
  this.scrollLeft = options.left;
};
HTMLElement.prototype.scrollBy = function (options) { this.scrollLeft += options.left; };
const captures = new Set();
HTMLElement.prototype.setPointerCapture = id => captures.add(id);
HTMLElement.prototype.hasPointerCapture = id => captures.has(id);
HTMLElement.prototype.releasePointerCapture = id => captures.delete(id);

const idle = new Map();
let nextIdle = 0;
window.requestIdleCallback = callback => { const id = ++nextIdle; idle.set(id, callback); return id; };
window.cancelIdleCallback = id => idle.delete(id);
globalThis.__flushDeckIdle = () => {
  const next = idle.entries().next().value;
  if (!next) return false;
  idle.delete(next[0]);
  next[1]();
  return true;
};
globalThis.__deckIdleCount = () => idle.size;
globalThis.__deckScrollCalls = scrollCalls;

const channels = [];
const NativeChannel = globalThis.MessageChannel;
globalThis.MessageChannel = class extends NativeChannel {
  constructor() { super(); channels.push(this); }
};
const bundle = await build({
  stdin: {
    contents: `
import React, { act, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import assert from 'node:assert/strict';
import { I18nProvider } from './src/hooks/useI18n';
import { CardDeck } from './src/components/CardDeck';
import { CardDeckPreview } from './src/components/CardDeckPreview';

export async function run() {
  const cards = Array.from({ length: 8 }, (_, index) => ({ id: 'c' + index, harness: { kind: 'codex', replyPreview: 'Reply ' + index } }));
  const renders = [], reports = [];
  const controls = {};
  function App() {
    const [focus, setFocus] = useState(2);
    const [reset, setReset] = useState(0);
    const navigation = useRef(null);
    controls.select = index => { setFocus(index); setReset(value => value + 1); };
    return <div className="cq-layout"><div className="cq-main"><div className="cq-stage">
      <CardDeck cards={cards} focusedIndex={focus} resetKey={reset} navigationRef={navigation}
        renderPreview={card => <CardDeckPreview card={card} title={'Title ' + card.id} subtitle="Workspace" />}
        onIndexChange={index => { reports.push(index); setFocus(index); }}
        renderCard={(card, active) => {
          renders.push(card.id);
          return <div data-content={card.id} data-active={active} />;
        }} />
    </div></div></div>;
  }
  const root = createRoot(document.getElementById('root'));
  const layer = index => document.querySelector('[data-deck-index="' + index + '"]');
  const active = index => layer(index).querySelector('[data-active="true"]');
  const warm = async () => { for (let i = 0; i < 10; i++) await act(async () => globalThis.__flushDeckIdle()); };
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const pointer = (type, clientX) => {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, button: 0 });
    Object.defineProperties(event, { pointerType: { value: 'mouse' }, pointerId: { value: 1 }, isPrimary: { value: true } });
    document.querySelector('.cq-main').dispatchEvent(event);
  };
  try {
    await act(async () => root.render(<I18nProvider><App /></I18nProvider>));
    await warm();
    const scroller = document.querySelector('.cq-deck-scroller');
    const scroll = async position => act(async () => {
      scroller.scrollLeft = position * 924;
      scroller.dispatchEvent(new Event('scroll'));
    });
    const end = async () => act(async () => scroller.dispatchEvent(new Event('scrollend')));
    assert.equal(document.querySelectorAll('[data-content]').length, 5);
    renders.length = 0;
    globalThis.__deckScrollCalls.length = 0;

    await scroll(2.51);
    assert.equal(layer(3).getAttribute('aria-hidden'), 'false', 'the new card brightens at the midpoint');
    assert.ok(active(2), 'the old conversation stays active during motion');
    assert.equal(active(3), null, 'history is not expanded midway through a swipe');
    assert.deepEqual(renders, [], 'crossing the midpoint does not render card contents');
    assert.deepEqual(reports, [], 'focus has not reached the shell');
    assert.equal(globalThis.__deckIdleCount(), 0, 'no preview loading during motion');
    await act(async () => pause(160));
    assert.deepEqual(reports, [], 'with native scrollend, a quiet interval is not the end of a gesture');
    await end();
    assert.deepEqual(reports, [3]);
    assert.ok(active(3), 'the resting conversation becomes active');
    assert.deepEqual(globalThis.__deckScrollCalls, [], 'reporting focus never snaps back or cancels the glide');
    await warm();

    // A fast swipe can cross several unloaded cards without mounting them.
    renders.length = 0;
    await scroll(4.7);
    await scroll(6.1);
    assert.equal(layer(6).getAttribute('aria-hidden'), 'false');
    assert.equal(layer(6).querySelector('[data-content]'), null);
    assert.equal(layer(6).querySelector('h2').textContent, 'Title c6', 'unmounted cards show their real title');
    assert.match(layer(6).textContent, /Workspace/);
    assert.match(layer(6).textContent, /Reply 6/, 'unmounted cards show the cached reply');
    assert.deepEqual(renders, []);
    assert.equal(globalThis.__deckIdleCount(), 0);
    await end();
    assert.deepEqual(reports, [3, 6], 'only the final card is reported');
    assert.ok(active(6));
    await warm();
    assert.ok(layer(2).querySelector('[data-content]'), 'a recently visited card stays mounted beyond the preload range');

    // Neither native scrollend nor the legacy idle timeout may activate a
    // conversation while a mouse is still holding the deck.
    await act(async () => pointer('pointerdown', 0));
    await act(async () => pointer('pointermove', 500));
    await scroll(5.4);
    await end();
    assert.deepEqual(reports, [3, 6]);
    delete HTMLElement.prototype.onscrollend;
    await scroll(5.4);
    await act(async () => pause(160));
    assert.deepEqual(reports, [3, 6]);
    // Already exactly on a card when released: no scroll event will follow.
    scroller.scrollLeft = 5 * 924;
    await act(async () => pointer('pointerup', 500));
    assert.deepEqual(reports, [3, 6, 5], 'releasing at an exact slot still settles');
    assert.ok(active(5));
    await warm();

    // Engines without scrollend still activate after the idle timeout.
    await scroll(4.1);
    assert.deepEqual(reports, [3, 6, 5]);
    await act(async () => pause(160));
    assert.deepEqual(reports, [3, 6, 5, 4]);
    assert.ok(active(4));

    scroller.scrollLeft = 4 * 924;
    await act(async () => {
      document.querySelector('.cq-main').dispatchEvent(new window.WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 924 }));
      scroller.dispatchEvent(new Event('scroll'));
    });
    await end();
    assert.deepEqual(reports, [3, 6, 5, 4], 'wheel completion waits for the wheel burst to end');
    await act(async () => pause(210));
    assert.deepEqual(reports, [3, 6, 5, 4, 5], 'a wheel burst ending on an exact slot still settles');
    assert.ok(active(5));

    await act(async () => controls.select(1));
    assert.equal(scroller.scrollLeft, 924, 'explicit navigation still moves the deck');
    assert.equal(layer(1).getAttribute('aria-hidden'), 'false');
    assert.ok(active(1));
    console.log('PASS: midpoint brightening renders 0 card contents; focus and loading wait for rest; native/legacy completion, dragging and explicit navigation work');
  } finally {
    await act(async () => root.unmount());
  }
}
`,
    loader: 'tsx',
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  jsx: 'automatic',
  banner: { js: "import {createRequire} from 'node:module';const require=createRequire(import.meta.url);" },
});
const dir = await mkdtemp(join(tmpdir(), 'que-deck-'));
try {
  const entry = join(dir, 'test.mjs');
  await writeFile(entry, bundle.outputFiles[0].text);
  await (await import(pathToFileURL(entry))).run();
} finally {
  dom.window.close();
  for (const channel of channels) { channel.port1.close(); channel.port2.close(); }
  await rm(dir, { recursive: true, force: true });
}
