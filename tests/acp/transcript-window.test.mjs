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
  "HTMLImageElement",
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
 const turn=i=>({id:'t'+i,text:'q'+i,state:'completed',attachments:[],blocks:[
  {type:'text_delta',stream:'thought',text:'thinking '+i},{type:'tool_call',toolCallId:'c'+i,title:'read '+i,status:'completed',content:[{type:'content',content:{type:'text',text:'output '+i}}]},
  {type:'text_delta',stream:'message',text:'reply '+i}]});
 const snapshot={state:'attention',turns:Array.from({length:75},(_,i)=>turn(i))};
 globalThis.fetch=async()=>({ok:true,json:async()=>structuredClone(snapshot)});
 const root=createRoot(document.getElementById('root'));
 const render=(key,active=true)=>act(async()=>root.render(<I18nProvider><AcpConversation key={key} card={{id:'card'}} active={active} onResume={async()=>{}}/></I18nProvider>));
 const push=(id='card')=>act(async()=>{globalThis.__streams.latest().emit('snapshot',structuredClone(snapshot),id);await new Promise(r=>setTimeout(r,30))});
 const box=()=>document.querySelector('.cq-acp-transcript');
 const shown=()=>[...document.querySelectorAll('.cq-acp-turn .cq-acp-user')].map(a=>Number(a.textContent.slice(1)));
 const scrollTo=async top=>act(async()=>{const b=box();b.dispatchEvent(new window.WheelEvent('wheel',{bubbles:true}));b.scrollTop=top;b.dispatchEvent(new window.Event('scroll'));});
 await render('a');await push();
 assert.equal(shown().length,15,'a long conversation opens with its last turns');assert.equal(shown()[0],60);
 assert.equal(box().scrollTop,1500,'at its end');
 // Finished turns fold their steps; the last one stays open.
 const turns=[...document.querySelectorAll('.cq-acp-turn')];
 assert.equal(document.querySelectorAll('.cq-acp-steps').length,14,'every finished turn but the last folds its steps');
 assert.equal(turns.at(-1).querySelector('.cq-acp-steps'),null,'the last turn shows its steps');
 assert.match(turns[0].querySelector('.cq-acp-steps summary').textContent,/2 步/,'the fold counts each thought and tool');
 assert.match(turns[0].textContent,/reply 60/,'a folded turn still shows its answer');
 assert.doesNotMatch(turns[0].textContent,/output 60|thinking 60/,'its steps are not in the page while folded');
 const steps=turns[0].querySelector('.cq-acp-steps');
 await act(async()=>{steps.open=true;steps.dispatchEvent(new window.Event('toggle'));});
 assert.match(turns[0].textContent,/read 60/,'opening the fold shows the steps');
 await scrollTo(1000);
 assert.equal(shown().length,15,'reading in the middle adds nothing');
 await scrollTo(200);
 assert.equal(shown().length,30,'near the top, earlier turns are added');assert.equal(shown()[0],45);
 assert.equal(box().scrollTop,1700,'and what was being read stays in place');
 snapshot.turns.push(turn(75));await push();
 assert.equal(shown()[0],45,'a new turn does not move the window');assert.equal(shown().length,31);
 await render('b');await push();
 assert.equal(shown()[0],45,'opened again, the same turns are shown');assert.equal(box().scrollTop,1700);
 await act(async()=>document.querySelector('.cq-acp-earlier').click());
 assert.equal(shown()[0],30,'the button shows 15 more');
 const retained=shown();
 await render('preview',false);
 assert.deepEqual(shown(),retained,'a mounted inactive card retains its history window');
 assert.equal(document.querySelector('.cq-acp-earlier').disabled,true,'the earlier-history row stays in place while inactive');
 await act(async()=>root.unmount());
 globalThis.__hidden=true;
 const hidden=createRoot(document.getElementById('root'));
 await act(async()=>hidden.render(<I18nProvider><AcpConversation card={{id:'hidden'}} active={true} onResume={async()=>{}}/></I18nProvider>));await push('hidden');
 assert.equal(shown().length,15,'a hidden conversation (no height) does not load its whole history');
 await act(async()=>hidden.unmount());globalThis.__hidden=false;
 console.log('PASS: long conversations render their last turns, fold finished steps, and grow upward on demand');
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
