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
import {encodeWav,audioBase64,appendTranscript,startRecorder} from './src/lib/speech';
let tracksStopped=0, contextsClosed=0, node, configured=true, resolveTranscription, editDraft, activate, setRunning;
const sent=[];const requests=[];let settingsSection;window.addEventListener('flat:open-settings',event=>settingsSection=event.detail.section);globalThis.CustomEvent=window.CustomEvent;
Object.defineProperty(globalThis,'navigator',{configurable:true,value:{mediaDevices:{getUserMedia:async()=>({getTracks:()=>[{stop:()=>tracksStopped++}]})}}});
class Context { sampleRate=16000; destination={}; audioWorklet={addModule:async()=>{}};createMediaStreamSource(){return {connect(){},disconnect(){}}}async resume(){}async close(){contextsClosed++} }
window.AudioContext=globalThis.AudioContext=Context;
globalThis.AudioWorkletNode=class {port={onmessage:null};constructor(){node=this}connect(){}disconnect(){}};
globalThis.fetch=async(url,init)=>{
 requests.push([url,init]);
 if(url.endsWith('/settings'))return {ok:true,json:async()=>({configured,language:'auto'})};
 return new Promise(resolve=>{resolveTranscription=text=>resolve({ok:true,json:async()=>({text})})});
};
function App(){const[running,updateRunning]=useState(false);setRunning=updateRunning;const[draft,setDraft]=useState('existing draft');const[active,setActive]=useState(true);editDraft=setDraft;activate=setActive;
return <I18nProvider><Composer active={active} draft={draft} onDraft={setDraft} attachments={[]} onFiles={()=>{}} onRemove={()=>{}} commands={[]} options={[]} busy={false} sending={false} running={running} stopping={false} onStop={()=>{}} disconnected={false} onSend={text=>sent.push(text)} onConfig={()=>{}}/></I18nProvider>}
export async function run(){
const bytes=encodeWav([new Float32Array([-2,-1,0,1,2])],16000),view=new DataView(bytes.buffer);
assert.equal(new TextDecoder().decode(bytes.subarray(0,4)),'RIFF');assert.equal(view.getUint32(24,true),16000);assert.equal(view.getUint32(40,true),10);assert.equal(view.getInt16(44,true),-32768);assert.equal(view.getInt16(52,true),32767);assert.equal(Buffer.from(audioBase64(bytes),'base64').length,54);
assert.equal(appendTranscript('draft','hello'),'draft hello');
assert.equal(appendTranscript('你好','继续说'),'你好继续说');
assert.equal(appendTranscript('hello ','world'),'hello world');
assert.equal(appendTranscript('你好，','继续说'),'你好，继续说');
const root=createRoot(document.getElementById('root'));const click=async e=>{assert.ok(e);await act(async()=>e.dispatchEvent(new MouseEvent('click',{bubbles:true})))};
await act(async()=>root.render(<App/>));
await click(document.querySelector('.fc-microphone'));
assert.equal(document.querySelector('.fc-microphone').getAttribute('aria-pressed'),'true');assert.equal(document.querySelector('.fc-send').disabled,false);
assert.equal(document.querySelector('.fc-toolbar').dataset.dictating,'true');
assert.equal(document.querySelectorAll('.fc-speech-waveform i').length,64);
await act(async()=>node.port.onmessage({data:new Float32Array(3200).fill(0.1)}));
assert.ok(parseFloat(document.querySelector('.fc-speech-waveform i:last-child').style.height)>3,'waveform reflects captured audio');
await click(document.querySelector('.fc-microphone'));assert.equal(tracksStopped,1);assert.equal(contextsClosed,1);
const body=JSON.parse(requests.at(-1)[1].body);assert.ok(body.audio);assert.equal(body.apiKey,undefined);
await act(async()=>editDraft('edited during transcription'));
await act(async()=>resolveTranscription('你好'));
assert.equal(document.querySelector('textarea').value,'edited during transcription你好');
await click(document.querySelector('.fc-microphone'));node.port.onmessage({data:new Float32Array([0.1])});await click(document.querySelector('.fc-microphone'));
await click(document.querySelector('[aria-label="Cancel voice input"]'));await act(async()=>resolveTranscription('must be ignored'));
assert.ok(!document.querySelector('textarea').value.includes('ignored'));
await click(document.querySelector('.fc-microphone'));await act(async()=>activate(false));assert.equal(tracksStopped,3);assert.equal(contextsClosed,3);
assert.equal(sent.length,0,'stop alone must not send');
await act(async()=>activate(true));
await click(document.querySelector('.fc-microphone'));node.port.onmessage({data:new Float32Array([0.1])});
await act(async()=>setRunning(true));
assert.equal(document.querySelector('.fc-send').getAttribute('aria-label'),'Add to queue');
await click(document.querySelector('.fc-send'));assert.equal(sent.length,0,'wait for transcription');assert.equal(document.querySelector('.fc-send').disabled,true);
await act(async()=>resolveTranscription('直接发送'));
assert.equal(sent.length,1);assert.equal(sent[0],document.querySelector('textarea').value);assert.ok(sent[0].endsWith('直接发送'));
configured=false;await click(document.querySelector('.fc-microphone'));assert.equal(settingsSection,'speech');assert.equal(document.querySelector('input[type=password]'),null,'credentials belong only in application settings');assert.equal(document.querySelector('.fc-microphone').getAttribute('aria-pressed'),'false');
configured=true;
const key=async(type,extra={})=>act(async()=>window.dispatchEvent(new window.KeyboardEvent(type,{code:'KeyD',key:'D',ctrlKey:true,shiftKey:true,bubbles:true,cancelable:true,...extra})));
await key('keydown');assert.equal(document.querySelector('.fc-microphone').getAttribute('aria-pressed'),'true');
const requestCount=requests.length;await key('keydown',{repeat:true});assert.equal(requests.length,requestCount);
node.port.onmessage({data:new Float32Array([0.1])});await key('keyup',{ctrlKey:false,shiftKey:false});
await act(async()=>resolveTranscription('hold dictation'));
assert.ok(document.querySelector('textarea').value.endsWith('hold dictation'));assert.equal(sent.length,1,'shortcut release must not send');
await key('keydown');await act(async()=>window.dispatchEvent(new Event('blur')));assert.equal(document.querySelector('.fc-microphone').getAttribute('aria-pressed'),'false');
const beforeLateGrant=tracksStopped;
await act(async()=>root.unmount());
let grant; navigator.mediaDevices.getUserMedia=()=>new Promise(resolve=>grant=resolve);
const abort=new AbortController();const pending=startRecorder(abort.signal,()=>{});abort.abort();grant({getTracks:()=>[{stop:()=>tracksStopped++}]});await assert.rejects(pending,{name:'AbortError'});assert.equal(tracksStopped,beforeLateGrant+1);
console.log('PASS: WAV contract, draft preservation, no auto-send, cancellation, card switch cleanup, missing key, late microphone permission');
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
const dir = await mkdtemp(join(tmpdir(), "flat-speech-"));
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
