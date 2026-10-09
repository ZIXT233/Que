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
 sessionStorage.setItem('queacp:draft:card','original draft');
 const queued={id:'queued',text:'queued draft',state:'queued',blocks:[],attachments:[{name:'test.txt',mediaType:'text/plain',data:'sample'}]};
 const snapshot={state:'working',turns:[{id:'active',text:'active',state:'running',blocks:[],attachments:[]},queued]};
 const requests=[];let deny=false,denyRestore=false;
 globalThis.fetch=async(url,init)=>{
   if(init?.body){const body=JSON.parse(init.body);requests.push(body);
     if(body.action==='send'){if(denyRestore)return {ok:false,json:async()=>({error:'offline'})};queued.withdrawn=false;queued.state='queued';queued.id=body.requestId;return {ok:true,json:async()=>structuredClone(queued)};}
     if(body.action==='cancel'){if(deny)return {ok:false,json:async()=>({error:'already running'})};queued.withdrawn=true;queued.state='cancelled';}
   }
   return {ok:true,json:async()=>structuredClone(snapshot)};
 };
 const root=createRoot(document.getElementById('root'));const click=async e=>{assert.ok(e);await act(async()=>e.click())};
 const push=async()=>act(async()=>{globalThis.__streams.latest().emit('snapshot',structuredClone(snapshot));await new Promise(resolve=>setTimeout(resolve,30))});
 await act(async()=>root.render(<I18nProvider><AcpConversation card={{id:'card'}} active={true} onResume={async()=>{}}/></I18nProvider>));
 await push();
 assert.equal(document.querySelectorAll('.cq-acp-turn').length,1);
 deny=true;await click(document.querySelector('[aria-label="Edit queued message"]'));assert.equal(document.querySelector('textarea').value,'original draft');
 deny=false;await click(document.querySelector('[aria-label="Edit queued message"]'));
 assert.equal(requests.at(-1).queuedOnly,true);assert.equal(document.querySelector('textarea').value,'queued draft');
 assert.match(document.querySelector('.fc-attachments').textContent,/test.txt/);
 denyRestore=true;await click(document.querySelector('.fc-editing-draft button'));
 assert.ok(document.querySelector('.fc-editing-draft'));assert.equal(document.querySelector('textarea').value,'queued draft');
 const restoreId=requests.at(-1).requestId;denyRestore=false;
 await click(document.querySelector('.fc-editing-draft button'));assert.equal(requests.at(-1).requestId,restoreId);assert.equal(requests.at(-1).text,'queued draft');assert.equal(requests.at(-1).attachments[0].name,'test.txt');assert.equal(queued.withdrawn,false);assert.equal(document.querySelector('textarea').value,'original draft');
 queued.withdrawn=false;queued.state='queued';
 await push(); // the stream reports the requeued message
 await click(document.querySelector('[aria-label="Edit queued message"]'));
 await click(document.querySelector('.fc-send'));
 assert.equal(requests.at(-1).action,'send');assert.equal(requests.at(-1).text,'queued draft');assert.equal(requests.at(-1).attachments[0].name,'test.txt');
 assert.equal(document.querySelector('textarea').value,'original draft');assert.equal(document.querySelector('.fc-editing-draft'),null);
 await act(async()=>root.unmount());console.log('PASS: queue separate from transcript, edit race guard, attachments, original draft restored after cancel and requeue');
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
const dir = await mkdtemp(join(tmpdir(), "queacp-composer-"));
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
