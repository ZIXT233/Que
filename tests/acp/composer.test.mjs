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
import React,{act,useState} from 'react';
import {createRoot} from 'react-dom/client';
import assert from 'node:assert/strict';
import {I18nProvider} from './src/hooks/useI18n';
import {Composer} from './src/components/chat/Composer';
import {stepAt,contextRatio,cacheHitRatio} from './src/components/chat/model';
let finish, deactivate, setRunning, setStopping, setDraft;let stops=0,sends=0;const calls=[];
function App(){const[draft,updateDraft]=useState('');setDraft=updateDraft;const [quote,setQuote]=useState('A quoted message');const [running,updateRunning]=useState(false),[stopping,updateStopping]=useState(false);setRunning=updateRunning;setStopping=updateStopping;const [busy,setBusy]=useState(false),[active,setActive]=useState(true),[values,setValues]=useState({model:'a',fast_mode:'off',effort:'low',collaboration_mode:'default',mode:'ask'});deactivate=()=>setActive(false);
const options=[{id:'mode',name:'Permissions',category:'mode',options:[{value:'ask',name:'Ask'}]},{id:'collaboration_mode',name:'Collaboration mode',options:[{value:'default',name:'Default'},{value:'plan',name:'Plan'}]},{id:'model',name:'Model',category:'model',options:[{value:'a',name:'Model A'},{value:'b',name:'Model B'}]},{id:'fast_mode',name:'Fast mode',options:[{value:'off',name:'Off'},{value:'on',name:'On'}]},{id:'effort',name:'Thinking',category:'thought_level',options:['low','medium','high','max'].map(value=>({value,name:value}))}].map(o=>({...o,currentValue:values[o.id]}));
return <I18nProvider><Composer history={["first message", "second message"]} active={active} quote={quote} onRemoveQuote={()=>setQuote('')} draft={draft} onDraft={updateDraft} attachments={[]} onFiles={()=>{}} onRemove={()=>{}} capabilities={{image:true}} commands={[]} options={options} busy={busy} sending={false} running={running} stopping={stopping} onStop={()=>stops++} disconnected={false} onSend={()=>sends++} onConfig={(o,v)=>{calls.push([o.id,v]);setBusy(true);finish=()=>{setValues(old=>({...old,[o.id]:v}));setBusy(false)}}}/></I18nProvider>}
export async function run(){
for(const width of [100,280,560])for(let i=0;i<5;i++)assert.equal(stepAt(30+14+(width-28)*i/4,30,width,5),i);
assert.equal(cacheHitRatio({cumulative:{inputTokens:100,cachedReadTokens:75,totalTokens:120,outputTokens:20}}),0.75);assert.equal(cacheHitRatio({cumulative:{inputTokens:10,cachedReadTokens:20}}),undefined);assert.equal(cacheHitRatio({cumulative:{inputTokens:100}}),undefined);assert.equal(cacheHitRatio({cumulative:{inputTokens:4367,cachedReadTokens:128768,outputTokens:720,totalTokens:133855}}),128768/133135);assert.equal(cacheHitRatio({cumulative:{inputTokens:10,cachedReadTokens:20,cachedWriteTokens:5,outputTokens:4,totalTokens:39}}),20/35);assert.equal(contextRatio(),undefined);assert.equal(contextRatio({used:0,size:100}),0);
const root=createRoot(document.getElementById('root'));const click=async e=>{assert.ok(e);await act(async()=>e.dispatchEvent(new MouseEvent('click',{bubbles:true})))};
await act(async()=>root.render(<App/>));
assert.equal(document.querySelector('textarea').value,'','quote must not fill draft');
assert.match(document.querySelector('.fc-quote-preview').textContent,/A quoted message/);
await click(document.querySelector('.fc-quote-preview button'));
assert.equal(document.querySelector('.fc-quote-preview'),null);
assert.equal(document.querySelector('textarea').value,'');
assert.equal(document.querySelector('input[type=file]').hidden,true);
let filePickerOpens=0;document.querySelector('input[type=file]').addEventListener('click',()=>filePickerOpens++);
await click(document.querySelector('.fc-toolbar-left .fc-icon-button'));
assert.ok(document.querySelector('.fc-add-menu'));assert.equal(filePickerOpens,0);
await click(document.querySelector('.fc-add-item'));assert.equal(filePickerOpens,1);assert.equal(document.querySelector('[role=dialog]'),null);
await click(document.querySelector('.fc-toolbar-left .fc-icon-button'));
const plan=()=>document.querySelector('.fc-add-item[aria-pressed]');
assert.equal(plan().getAttribute('aria-pressed'),'false');await click(plan());assert.deepEqual(calls.at(-1),['collaboration_mode','plan']);assert.equal(plan().disabled,true);
await act(async()=>finish());assert.equal(plan().getAttribute('aria-pressed'),'true');assert.ok(document.querySelector('.fc-mode-chip'));assert.ok(document.querySelector('.fc-text-button').compareDocumentPosition(document.querySelector('.fc-mode-chip')) & Node.DOCUMENT_POSITION_FOLLOWING,'plan chip follows permission control');
await click(document.querySelector('.fc-mode-chip button'));await act(async()=>finish());assert.equal(document.querySelector('.fc-mode-chip'),null);
assert.equal(document.querySelectorAll('.fc-toolbar-left .fc-text-button').length,1,'only permission has a separate toolbar setting');
await click(document.querySelector('.fc-model-button'));assert.equal(document.querySelector('.fc-model-top'),null);assert.ok(document.querySelector('.fc-effort-action .fc-speed'));assert.equal(document.querySelector('.fc-effort-track-row .fc-speed'),null);assert.ok(document.querySelector('.fc-effort-heading strong'));assert.equal(document.querySelector('.fc-speed-tooltip').textContent,'Fast mode');assert.equal(document.querySelector('.fc-effort-value .fc-speed'),null);await click(document.querySelector('.fc-model-title'));
await click([...document.querySelectorAll('[role=radio]')].find(e=>e.textContent==='Model B'));
assert.ok(document.querySelector('[role=dialog]'));assert.equal(document.querySelector('.fc-speed').disabled,true);
await act(async()=>finish());assert.match(document.querySelector('.fc-model-title').textContent,/Model B/);
await click(document.querySelector('.fc-speed'));await act(async()=>finish());assert.equal(document.querySelector('.fc-speed').getAttribute('aria-pressed'),'true');
const slider=document.querySelector('[role=slider]');slider.getBoundingClientRect=()=>({left:100,width:280});slider.setPointerCapture=()=>{};slider.releasePointerCapture=()=>{};
const pointer=async(type,x)=>{const e=new Event(type,{bubbles:true});Object.assign(e,{pointerId:1,button:0,clientX:x});await act(async()=>slider.dispatchEvent(e))};
const before=calls.length;await pointer('pointerdown',114);await pointer('pointermove',366);assert.equal(calls.length,before);await pointer('pointerup',366);assert.deepEqual(calls.at(-1),['effort','max']);assert.equal(calls.length,before+1);assert.equal(slider.getAttribute('aria-valuenow'),'3','pending request must not snap the thumb back');await act(async()=>finish());
await act(async()=>slider.dispatchEvent(new window.KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true})));
await act(async()=>slider.dispatchEvent(new window.KeyboardEvent('keyup',{key:'ArrowLeft',bubbles:true})));assert.deepEqual(calls.at(-1),['effort','high']);await act(async()=>finish());
await act(async()=>slider.dispatchEvent(new MouseEvent('click',{bubbles:true,detail:1,clientX:114})));assert.deepEqual(calls.at(-1),['effort','low']);await act(async()=>finish());
await act(async()=>document.querySelector('[role=dialog]').dispatchEvent(new window.KeyboardEvent('keydown',{key:'Escape',bubbles:true})));assert.equal(document.querySelector('[role=dialog]'),null);
await act(async()=>setRunning(true));
assert.equal(document.querySelector('.fc-send').disabled,false,'empty draft must not disable stop');
assert.equal(document.querySelector('.fc-send').getAttribute('aria-label'),'Stop');
await click(document.querySelector('.fc-send'));assert.equal(stops,1);assert.equal(sends,0);
await act(async()=>setDraft('next request'));assert.equal(document.querySelector('.fc-send').getAttribute('aria-label'),'Add to queue');
await click(document.querySelector('.fc-send'));assert.equal(sends,1);assert.equal(stops,1);
await act(async()=>document.querySelector('textarea').dispatchEvent(new window.KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true})));assert.equal(sends,2);
const enter=async(extra={})=>{const event=new window.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true,...extra});await act(async()=>document.querySelector('textarea').dispatchEvent(event));return event;};
assert.equal((await enter({shiftKey:true})).defaultPrevented,false);assert.equal(sends,2);
await enter({isComposing:true});await enter({keyCode:229});assert.equal(sends,2,'IME confirmation never sends');
assert.equal((await enter()).defaultPrevented,true);assert.equal(sends,3,'Enter queues while running');
await act(async()=>setRunning(false));await enter();assert.equal(sends,4,'Enter sends while idle');
await act(async()=>setRunning(true));
await act(async()=>setDraft(''));await enter();assert.equal(sends,4,'empty Enter does not send or stop');
await act(async()=>setStopping(true));assert.equal(document.querySelector('.fc-send').disabled,true);
await act(async()=>{setStopping(false);setRunning(false)});assert.equal(document.querySelector('.fc-send').disabled,true,'empty idle draft cannot send');
const arrow=async key=>{const event=new window.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true});await act(async()=>document.querySelector('textarea').dispatchEvent(event));return event;};
await arrow('ArrowUp');assert.equal(document.querySelector('textarea').value,'second message');
await arrow('ArrowUp');await arrow('ArrowUp');assert.equal(document.querySelector('textarea').value,'first message');
await arrow('ArrowDown');assert.equal(document.querySelector('textarea').value,'second message');
await arrow('ArrowDown');assert.equal(document.querySelector('textarea').value,'');
await act(async()=>setDraft('unfinished draft'));assert.equal((await arrow('ArrowUp')).defaultPrevented,false);assert.equal(document.querySelector('textarea').value,'unfinished draft');
await click(document.querySelector('.fc-model-button'));await act(async()=>deactivate());assert.equal(document.querySelector('[role=dialog]'),null);
await act(async()=>root.unmount());console.log('PASS: discrete geometry, model/Fast pending and acknowledgement, drag commit, keyboard commit, Escape and inactive-card close');}
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
