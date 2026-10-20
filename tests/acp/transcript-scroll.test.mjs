import { installEventSource } from './event-source.mjs';
import { JSDOM } from "jsdom";
import { build } from "esbuild";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
for (const k of [
  "window",
  "document",
  "HTMLElement",
  "Element",
  "Node",
  "Event",
  "MouseEvent",
  "MutationObserver",
])
  globalThis[k] = dom.window[k];
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.requestAnimationFrame = (f) => setTimeout(f, 0);
globalThis.cancelAnimationFrame = clearTimeout;
const resizeObservers = new Set();
globalThis.ResizeObserver = class {
  constructor(callback) { this.callback = callback; this.targets = new Set(); resizeObservers.add(this); }
  observe(target) { this.targets.add(target); }
  disconnect() { resizeObservers.delete(this); }
};
globalThis.__resizeTranscript = () => {
  for (const observer of resizeObservers) observer.callback([...observer.targets].map(target => ({
    target, contentRect: { height: target.classList.contains('cq-acp-transcript') ? target.clientHeight : target.parentElement.scrollHeight },
  })));
};
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const streams = installEventSource();
globalThis.__streams = streams;
const channels = [];
const NativeChannel = globalThis.MessageChannel;
globalThis.MessageChannel = class extends NativeChannel {
  constructor() {
    super();
    channels.push(this);
  }
};
// The transcript has no layout here: give it one.
globalThis.__transcriptLayoutFromTurns = false;
globalThis.__transcriptGeometryReads = 0;
globalThis.__transcriptViewportHeight = 200;
Object.defineProperty(dom.window.HTMLElement.prototype, "scrollHeight", { get() {
  if (!this.classList.contains("cq-acp-transcript")) return 0;
  globalThis.__transcriptGeometryReads++;
  return globalThis.__transcriptLayoutFromTurns
    ? this.querySelectorAll('.cq-acp-turn').length * 200 + this.querySelectorAll('.cq-acp-earlier').length * 32
    : 1000;
} });
Object.defineProperty(dom.window.HTMLElement.prototype, "clientHeight", { get() {
  if (!this.classList.contains("cq-acp-transcript")) return 0;
  globalThis.__transcriptGeometryReads++;
  return globalThis.__transcriptViewportHeight;
} });
// Model the browser clamping an offset when the rendered history shrinks.
const offsets = new WeakMap();
Object.defineProperty(dom.window.HTMLElement.prototype, "scrollTop", {
  get() {
    let value = offsets.get(this) ?? 0;
    if (globalThis.__transcriptLayoutFromTurns && this.classList.contains('cq-acp-transcript')) {
      value = Math.min(value, Math.max(0, this.scrollHeight - this.clientHeight));
      offsets.set(this, value);
    }
    return value;
  },
  set(value) {
    if (globalThis.__transcriptLayoutFromTurns && this.classList.contains('cq-acp-transcript')) {
      value = Math.min(value, Math.max(0, this.scrollHeight - this.clientHeight));
    }
    offsets.set(this, value);
  },
});
const result = await build({
  stdin: {
    contents: `
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import assert from 'node:assert/strict';
import {I18nProvider} from './src/hooks/useI18n';
import {AcpConversation} from './src/components/AcpConversation';
export async function run(){
 globalThis.sessionStorage=window.sessionStorage;
 const snapshot={state:'attention',turns:[{id:'t',text:'hi',state:'completed',attachments:[],blocks:[{type:'text_delta',stream:'message',text:'reply'}]}]};
 globalThis.fetch=async()=>({ok:true,json:async()=>structuredClone(snapshot)});
 const root=createRoot(document.getElementById('root'));
 const render=(key,active=true,id='card')=>act(async()=>root.render(<I18nProvider><AcpConversation key={key} card={{id}} active={active} onResume={async()=>{}}/></I18nProvider>));
 const push=()=>act(async()=>{globalThis.__streams.latest().emit('snapshot',{id:'card',data:structuredClone(snapshot)});await new Promise(r=>setTimeout(r,30))});
 const box=()=>document.querySelector('.cq-acp-transcript');
 const scrollTo=async(top,user)=>act(async()=>{const b=box();if(user)b.dispatchEvent(new window.WheelEvent('wheel',{bubbles:true}));b.scrollTop=top;b.dispatchEvent(new window.Event('scroll'));});
 const latest=()=>[...document.querySelectorAll('button')].find(b=>/回到最新/.test(b.textContent));
 await render('deck');await push();
 assert.equal(box().scrollTop,1000,'a conversation opens at its end');
 await scrollTo(0,false);
 assert.equal(latest(),undefined,'a scroll caused by layout does not stop following');
 await push();assert.equal(box().scrollTop,1000,'and the end is kept');
 await scrollTo(300,true);
 assert.ok(latest(),'scrolling up by hand stops following');
 await push();assert.equal(box().scrollTop,300,'new content does not move what is being read');
 await render('elsewhere');await push();
 assert.equal(box().scrollTop,300,'opened again, it returns to the place being read');
 await act(async()=>latest().click());
 assert.equal(box().scrollTop,1000,'back to the latest');assert.equal(latest(),undefined);

 globalThis.__transcriptLayoutFromTurns=true;
 snapshot.turns=Array.from({length:25},(_,i)=>({id:'t'+i,text:'question '+i,state:'completed',attachments:[],blocks:[{type:'text_delta',stream:'message',text:'answer '+i}]}));
 await render('reading',true,'long-card');
 assert.equal(box().querySelectorAll('.cq-acp-turn').length,15);
 await scrollTo(1200,true);
 const readingHeight=box().scrollHeight;
 assert.ok(latest());
 await render('reading',false,'long-card');
 assert.equal(box().scrollHeight,readingHeight,'a reading card keeps its history when it leaves the front');
 assert.equal(box().scrollTop,1200,'swiping away cannot clamp the reading position to a shorter preview');
 await render('reading',true,'long-card');
 assert.equal(box().scrollTop,1200,'returning to the card preserves the same reading position');
 await render('reading',false,'long-card');
 await scrollTo(2000,false);
 await render('remounted',true,'long-card');
 assert.equal(box().scrollTop,1200,'background layout scrolls do not overwrite the retained position');
 assert.ok(latest(),'background layout scrolls do not enable following the end');
 await act(async()=>latest().click());
 assert.equal(box().scrollTop,box().scrollHeight-box().clientHeight,'back to latest still works after returning');
 const restingHeight=box().scrollHeight,restingTop=box().scrollTop;
 const restingTurns=[...box().querySelectorAll('.cq-acp-turn')];
 await render('remounted',false,'long-card');
 assert.equal(box().scrollHeight,restingHeight,'a mounted card keeps the same history height while inactive');
 assert.equal(box().scrollTop,restingTop,'deactivation does not clamp a card following the latest');
 assert.deepEqual([...box().querySelectorAll('.cq-acp-turn')],restingTurns,'the rendered turns retain their DOM');
 globalThis.__transcriptGeometryReads=0;
 await render('remounted',true,'long-card');
 assert.equal(globalThis.__transcriptGeometryReads,0,'focus changes do not synchronously measure a mounted transcript');
 assert.equal(box().scrollHeight,restingHeight,'activation does not expand history or insert another row');
 assert.equal(box().scrollTop,restingTop,'activation needs no second scroll adjustment');
 assert.deepEqual([...box().querySelectorAll('.cq-acp-turn')],restingTurns);
 // An inactive short window can still fill the viewport on activation,
 // using sizes the browser already delivered rather than a focus-time read.
 await render('remounted',false,'long-card');
 globalThis.__transcriptViewportHeight=4000;
 await act(async()=>globalThis.__resizeTranscript());
 assert.equal(box().querySelectorAll('.cq-acp-turn').length,15,'inactive views do not expand their history');
 await render('remounted',true,'long-card');
 await act(async()=>globalThis.__resizeTranscript());
 assert.equal(box().querySelectorAll('.cq-acp-turn').length,25,'a short view fills from cached resize measurements when activated');
 await act(async()=>root.unmount());console.log('PASS: reading survives swiping and remounting; active changes preserve history height, turn DOM and scroll offset');
}
`,
    loader: "tsx",
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  jsx: "automatic",
  loader: { ".css": "empty" },
  banner: {
    js: "import {createRequire} from 'node:module';const require=createRequire(import.meta.url);",
  },
});
const dir = await mkdtemp(join(tmpdir(), "que-scroll-"));
try {
  const entry = join(dir, "test.mjs");
  await writeFile(entry, result.outputFiles[0].text);
  await (await import(pathToFileURL(entry))).run();
} finally {
  dom.window.close();
  for (const c of channels) {
    c.port1.close();
    c.port2.close();
  }
  await rm(dir, { recursive: true, force: true });
}
