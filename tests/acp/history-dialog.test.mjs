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
import {useAcpHistory,filterHistoryEntries} from './src/hooks/useAcpHistory';
export async function run(){
 const entries=['working','waiting','archived','external'].map(id=>({recordId:id,cardId:id==='external'?undefined:id,title:id,agent:'codex',cwd:'/tmp',updatedAt:''}));
 const cards=[{id:'working',harness:{}},{id:'waiting',harness:{}},{id:'archived',harness:{},archivedAt:123}];
 assert.deepEqual(filterHistoryEntries(entries,cards,'').map(e=>e.recordId),['archived','external']);
 assert.deepEqual(filterHistoryEntries(entries,[...cards,{id:'external-card',harness:{}}],'arch').map(e=>e.recordId),['archived']);

 const requests=[],results=[],errors=[];
 globalThis.fetch=(url,options)=>new Promise(resolve=>requests.push({url,options,resolve}));
 const onResult=value=>results.push(value),onError=value=>errors.push(value),onLoading=()=>{};
 function App({enabled,workspace}){useAcpHistory(workspace,enabled,onResult,onError,onLoading);return null;}
 const root=createRoot(document.getElementById('root'));
 const render=(enabled,workspace='first')=>act(async()=>root.render(<App enabled={enabled} workspace={workspace}/>));
 await render(true);assert.equal(requests.length,1);
 await render(false);assert.equal(requests[0].options.signal.aborted,true);
 await act(async()=>requests[0].resolve({ok:true,json:async()=>[{recordId:'late'}]}));
 assert.equal(results.length,0,'closed history cannot be reopened by a late response');
 await render(false,'new-workspace');assert.equal(requests.length,1,'new-session flow must not fetch history');
 await render(true,'second');await render(true,'third');
 await act(async()=>requests[1].resolve({ok:true,json:async()=>[{recordId:'old-workspace'}]}));
 assert.equal(results.length,0,'workspace switch discards stale result');
 await act(async()=>requests[2].resolve({ok:true,json:async()=>[{recordId:'current'}]}));
 assert.equal(results[0][0].recordId,'current');
 await render(false,'third');await render(true,'third');assert.equal(requests.length,4,'reopening the same workspace fetches again');
 await act(async()=>root.unmount());assert.equal(requests[3].options.signal.aborted,true);
 console.log('PASS: close/new-session flow, stale responses, workspace switch, reopening');
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
