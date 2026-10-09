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
import {PermissionCard} from './src/components/chat/PermissionCard';
export async function run(){
 window.localStorage.setItem('pi-locale','zh-CN');
 const root=createRoot(document.getElementById('root')),answers=[];
 const request={toolCall:{title:'Implement this plan?',rawInput:{plan:'# Test plan'+String.fromCharCode(10,10)+'Do the work.'}},options:[{optionId:'yes',kind:'allow_once',name:'Yes, implement this plan'},{optionId:'no',kind:'reject_once',name:'No, and tell Codex what to do differently'}]};
 const render=(disabled=false,value=request)=>act(async()=>root.render(<I18nProvider><PermissionCard request={value} disabled={disabled} onAnswer={a=>answers.push(a)}/></I18nProvider>));
 await render();
 assert.match(document.body.textContent,/Implement this plan/);assert.match(document.body.textContent,/Yes, implement this plan/);
 assert.equal(document.querySelector('details').open,false);assert.equal(document.querySelector('pre'),null);
 assert.equal(document.querySelector('.fc-permission-preview h1').textContent,'Test plan');
 await act(async()=>document.querySelector('.is-primary').click());assert.deepEqual(answers,[{outcome:'allow_once'}]);
 await render(true);await act(async()=>document.querySelector('.is-primary').click());assert.equal(answers.length,1);
 await render(false,{toolCall:{title:'Custom approval',rawInput:{command:'example'}},options:[{optionId:'custom',kind:'allow_always',name:'Allow only this custom scope'}]});
 assert.match(document.body.textContent,/Allow only this custom scope/);assert.equal(document.querySelector('details').open,false);
 const prefix='touch /Users/example/test.tmp';
 await render(false,{toolCall:{title:'Run command',rawInput:{command:prefix,reason:'needs access'}},options:[{optionId:'prefix',kind:'allow_always',name:"Yes, and don't ask again for commands that start with "+String.fromCharCode(96)+prefix+String.fromCharCode(96)},{optionId:'no',kind:'reject_once',name:'No, and tell Codex what to do differently'},{optionId:'yes',kind:'allow_once',name:'Yes, proceed'}]});
 assert.equal(document.querySelector('.fc-permission-heading strong').textContent,'Run command');
 assert.equal(document.querySelector('.fc-permission-command').textContent,prefix);

 const buttons=[...document.querySelectorAll('.fc-permission-actions button')];
 assert.ok(buttons[0].textContent.includes(prefix));assert.equal(buttons[1].textContent,'No, and tell Codex what to do differently');assert.equal(buttons[2].textContent,'Yes, proceed');
 await act(async()=>buttons[0].click());assert.deepEqual(answers.at(-1),{outcome:'allow_always'});
 await act(async()=>buttons[1].click());assert.deepEqual(answers.at(-1),{outcome:'reject_once'});
 await render(false,{options:[{optionId:'session',kind:'allow_always',name:'Allow this session'},{optionId:'project',kind:'allow_always',name:'Allow this project'},{optionId:'once',kind:'allow_once',name:'Allow'},{optionId:'reject',kind:'reject_once',name:'Reject'}]});
 const scopes=[...document.querySelectorAll('.fc-permission-actions button')];assert.equal(scopes[0].disabled,true);assert.equal(scopes[1].disabled,true);assert.equal(scopes[2].disabled,false);assert.equal(scopes[3].disabled,false);
 const before=answers.length;await act(async()=>scopes[1].click());assert.equal(answers.length,before);
 await act(async()=>root.unmount());console.log('PASS: localized plan, collapsed Markdown preview, unchanged permission outcome, pending lock, custom scope preservation');
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
