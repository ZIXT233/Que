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
globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
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
// Each turn is 100px tall.
Object.defineProperty(dom.window.HTMLElement.prototype, "scrollHeight", { get() { return this.classList.contains("cq-acp-transcript") && !globalThis.__hidden ? 100 * this.querySelectorAll(".cq-acp-turn").length : 0; } });
Object.defineProperty(dom.window.HTMLElement.prototype, "clientHeight", { get() { return this.classList.contains("cq-acp-transcript") && !globalThis.__hidden ? 200 : 0; } });
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
 const turn=i=>({id:'t'+i,text:'q'+i,state:'completed',attachments:[],blocks:[{type:'text_delta',stream:'message',text:'reply '+i}]});
 const snapshot={state:'attention',turns:Array.from({length:75},(_,i)=>turn(i))};
 globalThis.fetch=async()=>({ok:true,json:async()=>structuredClone(snapshot)});
 const root=createRoot(document.getElementById('root'));
 const render=key=>act(async()=>root.render(<I18nProvider><AcpConversation key={key} card={{id:'card'}} active={true} onResume={async()=>{}}/></I18nProvider>));
 const push=()=>act(async()=>{globalThis.__streams.latest().emit('snapshot',structuredClone(snapshot));await new Promise(r=>setTimeout(r,30))});
 const box=()=>document.querySelector('.cq-acp-transcript');
 const shown=()=>[...document.querySelectorAll('.cq-acp-turn')].map(a=>a.textContent.match(/q(\\d+)/)[1]*1);
 const scrollTo=async top=>act(async()=>{const b=box();b.dispatchEvent(new window.WheelEvent('wheel',{bubbles:true}));b.scrollTop=top;b.dispatchEvent(new window.Event('scroll'));});
 await render('a');await push();
 assert.equal(shown().length,30,'a long conversation opens with its last turns');assert.equal(shown()[0],45);
 assert.equal(box().scrollTop,3000,'at its end');
 await scrollTo(1000);
 assert.equal(shown().length,30,'reading in the middle adds nothing');
 await scrollTo(200);
 assert.equal(shown().length,60,'near the top, earlier turns are added');assert.equal(shown()[0],15);
 assert.equal(box().scrollTop,3200,'and what was being read stays in place');
 snapshot.turns.push(turn(75));await push();
 assert.equal(shown()[0],15,'a new turn does not move the window');assert.equal(shown().length,61);
 await render('b');await push();
 assert.equal(shown()[0],15,'opened again, the same turns are shown');assert.equal(box().scrollTop,3200);
 await act(async()=>document.querySelector('.cq-acp-earlier').click());
 assert.equal(shown()[0],0,'the button shows the rest');
 await act(async()=>root.unmount());
 globalThis.__hidden=true;
 const hidden=createRoot(document.getElementById('root'));
 await act(async()=>hidden.render(<I18nProvider><AcpConversation card={{id:'hidden'}} active={true} onResume={async()=>{}}/></I18nProvider>));await push();
 assert.equal(shown().length,30,'a hidden conversation (no height) does not load its whole history');
 await act(async()=>hidden.unmount());globalThis.__hidden=false;
 console.log('PASS: long conversations render their last turns and grow upward on demand');
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
const dir = await mkdtemp(join(tmpdir(), "queacp-window-"));
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
