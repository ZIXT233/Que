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
import {I18nProvider} from './src/hooks/useI18n';
import {ActivityGroup,groupActivityBlocks} from './src/components/chat/ActivityGroup';
export async function run(){
 const first={type:'tool_call',toolCallId:'a',title:'Read file',status:'completed'};
 const second={type:'tool_call',toolCallId:'b',title:'Run tests',status:'in_progress'};
 const thought={type:'text_delta',stream:'thought',text:'checking'};
 const prose={type:'text_delta',stream:'output',text:'Here is the result'};
 const approval={type:'decision',id:'approval'};
 const groups=groupActivityBlocks([first,thought,second,prose,first,approval,second]);
 assert.equal(groups.length,5);assert.equal(groups[0].activities.length,3);assert.equal(groups[1].block,prose);assert.equal(groups[3].block,approval);
 const root=createRoot(document.getElementById('root'));
 const render=async blocks=>act(async()=>root.render(<I18nProvider><ActivityGroup blocks={blocks} running={true}/></I18nProvider>));
 await render([first,thought,second]);
 const group=document.querySelector('.fc-activity-group');assert.equal(group.open,false);
 assert.match(group.querySelector('summary').textContent,/Run tests/);
 group.open=true;
 await render([first,thought,{...second,status:'completed'},{...first,toolCallId:'c',title:'Build',status:'in_progress'}]);
 assert.equal(document.querySelector('.fc-activity-group'),group);assert.equal(group.open,true);assert.match(group.querySelector('summary').textContent,/Build/);
 await render([first,thought,{...second,status:'completed'}]);
 assert.match(group.querySelector('summary').textContent,/2 tool calls/);assert.equal(group.querySelectorAll('.cq-acp-tool').length,2);
 await render([first,{...second,status:'failed'}]);assert.ok(group.querySelector('[data-failed="true"]'));
 await render([thought]);
 assert.equal(document.querySelectorAll('details').length,1,'thought-only groups have one disclosure');
 assert.equal(document.querySelectorAll('summary').length,1);
 assert.equal(document.querySelector('.fc-activity-items .markdown-content-root').textContent,'checking');
 await render([first,thought]);
 assert.equal(document.querySelectorAll('.fc-activity-items > details').length,1,'only the tool has a nested detail; thoughts render directly');
 await act(async()=>root.unmount());console.log('PASS: activity grouping preserves prose and approval boundaries, live summary updates and expansion state');
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
