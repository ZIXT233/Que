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
 const reply=text=>({type:'text_delta',stream:'message',text});
 const yang={cardId:'yang',name:'杨金水'},shen={cardId:'shen',name:'沈一石'};
 const snapshot={state:'attention',turns:[
  {id:'from-peer',text:'你那边好了吗？',source:'agent',sender:shen,state:'completed',attachments:[],blocks:[reply('好了')]},
  {id:'mine',text:'继续',source:'user',state:'completed',attachments:[],blocks:[
   {type:'tool_call',toolCallId:'t1',title:'send_message',status:'completed'},
   {type:'message',direction:'out',to:[yang,shen],text:'请拉取后重启'},
   {type:'tool_call',toolCallId:'t2',title:'wait_messages',status:'completed'},
   {type:'message',direction:'in',from:yang,text:'构建好了'},
   {type:'message',direction:'out',to:[yang],all:true,text:'大家下班'},
   reply('收到')]},
 ]};
 globalThis.fetch=async()=>({ok:true,json:async()=>structuredClone(snapshot)});
 const root=createRoot(document.getElementById('root'));
 await act(async()=>root.render(<I18nProvider><AcpConversation card={{id:'card'}} active={true} onResume={async()=>{}}/></I18nProvider>));
 await act(async()=>{globalThis.__streams.latest().emit('snapshot',structuredClone(snapshot));await new Promise(resolve=>setTimeout(resolve,30))});
 const [peerTurn,myTurn]=document.querySelectorAll('.cq-acp-turn');
 assert.equal(peerTurn.querySelector('.cq-acp-user'),null,'another card is not drawn as the user');
 const received=peerTurn.querySelector('.cq-acp-msg--in');
 assert.match(received.textContent,/来自 沈一石/);assert.match(received.textContent,/你那边好了吗？/);
 assert.ok(myTurn.querySelector('.cq-acp-user'),'the user is still on the user side');
 const messages=[...myTurn.querySelectorAll('.cq-acp-response .cq-acp-msg')];
 assert.deepEqual(messages.map(m=>m.className.split('--')[1]),['out','in','out'],'color follows direction, in order');
 assert.match(messages[0].textContent,/发给 杨金水、沈一石/);assert.match(messages[0].textContent,/请拉取后重启/);
 assert.match(messages[1].textContent,/来自 杨金水/);
 assert.match(messages[2].textContent,/发给 全部/,'a broadcast says so');
 await act(async()=>root.unmount());console.log('PASS: card messages sit on the Agent side, blue received and green sent, in turn order');
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
const dir = await mkdtemp(join(tmpdir(), "queacp-message-ui-"));
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
