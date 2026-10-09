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
import {messagesIn} from './src/lib/peer-messages';
export async function run(){
 globalThis.sessionStorage=window.sessionStorage;
 // MCP results come as text content holding JSON; some agents nest it in ACP content.
 const handed={cards:[],queacpMessages:[{from:{cardId:'yang',name:'杨金水'},text:'构建好了'}]};
 assert.equal(messagesIn({rawOutput:{content:[{type:'text',text:JSON.stringify(handed)}]}})[0].text,'构建好了');
 assert.equal(messagesIn({content:[{type:'content',content:{type:'text',text:JSON.stringify(handed)}}]})[0].from.name,'杨金水');
 assert.deepEqual(messagesIn({rawOutput:'plain output'}),[]);
 assert.deepEqual(messagesIn({rawOutput:{queacpMessages:[{text:'no sender'}]}}),[],'malformed entries are not drawn');
 const reply=text=>({type:'text_delta',stream:'message',text});
 const snapshot={state:'attention',turns:[
  {id:'from-peer',text:'你那边好了吗？',source:'agent',sender:{cardId:'shen',name:'沈一石'},state:'completed',attachments:[],blocks:[reply('好了')]},
  {id:'mine',text:'继续',source:'user',state:'completed',attachments:[],blocks:[
   {type:'tool_call',toolCallId:'t1',title:'list_cards',status:'completed',rawOutput:{content:[{type:'text',text:JSON.stringify(handed)}]}},reply('收到')]},
 ]};
 globalThis.fetch=async()=>({ok:true,json:async()=>structuredClone(snapshot)});
 const root=createRoot(document.getElementById('root'));
 await act(async()=>root.render(<I18nProvider><AcpConversation card={{id:'card'}} active={true} onResume={async()=>{}}/></I18nProvider>));
 await act(async()=>{globalThis.__streams.latest().emit('snapshot',structuredClone(snapshot));await new Promise(resolve=>setTimeout(resolve,30))});
 const [peerTurn,myTurn]=document.querySelectorAll('.cq-acp-turn');
 assert.equal(peerTurn.querySelector('.cq-acp-user'),null,'another card is not drawn as the user');
 assert.match(peerTurn.querySelector('.cq-acp-peer').textContent,/来自 沈一石/);
 assert.match(peerTurn.querySelector('.cq-acp-peer').textContent,/你那边好了吗？/);
 assert.ok(myTurn.querySelector('.cq-acp-user'),'the user is still on the user side');
 const handedOver=myTurn.querySelector('.cq-acp-response .cq-acp-peer');
 assert.match(handedOver.textContent,/来自 杨金水/);assert.match(handedOver.textContent,/构建好了/);
 assert.equal(document.querySelectorAll('.cq-acp-peer').length,2);
 await act(async()=>root.unmount());console.log('PASS: messages from other cards are drawn on the Agent side, tinted, wherever they arrive');
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
const dir = await mkdtemp(join(tmpdir(), "queacp-peer-ui-"));
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
