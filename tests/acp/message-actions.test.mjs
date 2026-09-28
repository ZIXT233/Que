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
import {MessageActions} from './src/components/chat/MessageActions';
export async function run(){
 window.localStorage.setItem('pi-locale','zh-CN');const copied=[],quoted=[];
 window.queDesktop={writeClipboardText:async text=>{copied.push(text);return true;}};
 const root=createRoot(document.getElementById('root'));
 const render=text=>act(async()=>root.render(<I18nProvider><MessageActions text={text} onQuote={text=>quoted.push(text)}/></I18nProvider>));
 await render('**original markdown**');await act(async()=>document.querySelector('[aria-label="复制"]').click());
 assert.deepEqual(copied,['**original markdown**']);assert.ok(document.querySelector('[aria-label="已复制"]'));
 await act(async()=>document.querySelector('[aria-label="引用到输入框"]').click());assert.deepEqual(quoted,['**original markdown**']);
 await render('');assert.equal(document.querySelector('[role=group]'),null);
 await act(async()=>root.unmount());console.log('PASS: original message copy, quote callback, copied feedback and empty message hiding');
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
const dir = await mkdtemp(join(tmpdir(), "flat-composer-"));
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
