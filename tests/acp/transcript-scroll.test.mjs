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
Object.defineProperty(dom.window.HTMLElement.prototype, "scrollHeight", { get() { return this.classList.contains("cq-acp-transcript") ? 1000 : 0; } });
Object.defineProperty(dom.window.HTMLElement.prototype, "clientHeight", { get() { return this.classList.contains("cq-acp-transcript") ? 200 : 0; } });
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
 const render=key=>act(async()=>root.render(<I18nProvider><AcpConversation key={key} card={{id:'card'}} active={true} onResume={async()=>{}}/></I18nProvider>));
 const push=()=>act(async()=>{globalThis.__streams.latest().emit('snapshot',structuredClone(snapshot));await new Promise(r=>setTimeout(r,30))});
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
 await act(async()=>root.unmount());console.log('PASS: only the user moves the transcript; its place survives remounting');
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
const dir = await mkdtemp(join(tmpdir(), "queacp-scroll-"));
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
