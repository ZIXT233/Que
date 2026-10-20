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
 const id='config-card';
 const option={id:'fast-mode',name:'Fast mode',category:'model_config',currentValue:'off',options:[{value:'off',name:'Off'},{value:'on',name:'On'}]};
 const snapshot={ownerEpoch:'e',revision:5,state:'attention',turns:[],commands:[{name:'compact'}],status:{details:{configOptions:[option]}}};
 const requests=[];
 // Reading the card waits for the stream's first delivery, so the view is seen loading first.
 let delivered;const streamed=new Promise(resolve=>delivered=resolve);
 const push=async(data)=>act(async()=>{globalThis.__streams.latest().emit('snapshot',data,id);delivered();await new Promise(r=>setTimeout(r,30))});
 globalThis.fetch=async(url,init)=>{
 if(!init?.body)await streamed;
 if(init?.body){const body=JSON.parse(init.body);requests.push(body);if(body.action==='config'){option.currentValue=body.value;snapshot.revision++;}if(body.action==='send'){const turn={id:body.requestId,text:body.text,attachments:body.attachments,state:'running',blocks:[]};snapshot.turns.push(turn);return {ok:true,json:async()=>structuredClone(turn)};}}
 return {ok:true,json:async()=>structuredClone(snapshot)};
 };
 const root=createRoot(document.getElementById('root'));
 try {
 await act(async()=>{root.render(<I18nProvider><AcpConversation card={{id}} active={true} onResume={async()=>{}}/></I18nProvider>)});
 assert.ok(document.querySelector('.cq-acp-loading'));assert.equal(document.querySelector('.cq-acp-welcome'),null);
 await push(structuredClone(snapshot));
 assert.equal(document.querySelector('.cq-acp-loading'),null);
 await act(async()=>document.querySelector('.fc-model-button').click());

 await act(async()=>{document.querySelector('.fc-speed').click();await new Promise(r=>setTimeout(r,300))});
 assert.deepEqual(requests,[{action:'config',key:'fast-mode',value:'on'}]);
 assert.equal(document.querySelector('.fc-speed').getAttribute('aria-pressed'),'true');
 // The stream must never roll a confirmed change back: an older snapshot of the same owner is ignored.
 await push({...structuredClone(snapshot),revision:5,status:{details:{configOptions:[{...option,currentValue:'off'}]}}});
 assert.equal(document.querySelector('.fc-speed').getAttribute('aria-pressed'),'true');
 await act(async()=>{document.querySelector('.fc-speed').click();await new Promise(r=>setTimeout(r,50))});
 assert.equal(document.querySelector('.fc-speed').getAttribute('aria-pressed'),'false');
 assert.equal(requests.at(-1).value,'off');
 await act(async()=>document.querySelector('.fc-model-button').click());
 sessionStorage.setItem('que:draft:'+id,'keep draft');
 await act(async()=>document.querySelector('.fc-toolbar-right .fc-icon-button').click());
 const compact=Array.from(document.querySelectorAll('.fc-usage button')).find(b=>b.textContent==='Compact context');
 assert.ok(compact);await act(async()=>compact.click());
 assert.equal(requests.at(-1).text,'/compact');assert.deepEqual(requests.at(-1).attachments,[]);
 console.log('PASS: conversation Fast toggle round trip, ordered stream and advertised compact command');
 } finally {
 await act(async()=>root.unmount());

 }

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
const dir = await mkdtemp(join(tmpdir(), "que-composer-"));
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
