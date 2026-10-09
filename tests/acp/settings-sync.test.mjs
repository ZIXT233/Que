import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {build} from 'esbuild';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
test('settings synchronize both directions, preserve remote values and reject stale reads',async()=>{
 const dom=new JSDOM('',{url:'http://localhost'});
 for(const key of ['window','document','StorageEvent','CustomEvent'])globalThis[key]=dom.window[key];
 const dir=await mkdtemp(join(tmpdir(),'queacp-settings-ui-'));
 const originalInterval=globalThis.setInterval,originalClear=globalThis.clearInterval;let poll;
 globalThis.setInterval=fn=>(poll=fn,1);globalThis.clearInterval=()=>{};
 let values={theme:'dark',language:'zh-CN'};let held;let hold=false;let offline=false;const writes=[];let events=0;
 window.addEventListener('storage',()=>events++);
 globalThis.fetch=async(_url,options)=>{
  if(offline)throw new Error('backend restarting');
  if(options?.body){const body=JSON.parse(options.body);writes.push(body);for(const[k,v]of Object.entries(body.patch))if(!body.onlyMissing||!(k in values))values[k]=v;}
  const snapshot=structuredClone(values);
  if(hold&&!options?.body){hold=false;await new Promise(resolve=>held=resolve);}
  return {ok:true,json:async()=>snapshot};
 };
 try{
  const result=await build({stdin:{contents:"export {startSettingsSync} from './src/lib/settings-sync';export {persistentStorage} from './src/lib/persistent-storage';",resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'node'});
  const file=join(dir,'settings.mjs');await writeFile(file,result.outputFiles[0].text);const {startSettingsSync,persistentStorage}=await import(pathToFileURL(file));
  window.localStorage.setItem('pi-theme','light');window.localStorage.setItem('que:sound-enabled','false');
  const stop=await startSettingsSync();
  assert.equal(values.theme,'dark');assert.equal(values.soundEnabled,false);assert.equal(persistentStorage().getItem('pi-theme'),'dark');assert.ok(events>=2);
  const before=writes.length;values.theme='auto';await poll();await new Promise(r=>setTimeout(r,0));assert.equal(persistentStorage().getItem('pi-theme'),'auto');assert.equal(writes.length,before,'remote updates never echo a write');
  hold=true;poll();await new Promise(r=>setTimeout(r,0));assert.ok(held);
  persistentStorage().setItem('pi-theme','light');await new Promise(r=>setTimeout(r,10));
  assert.equal(values.theme,'light');held();await new Promise(r=>setTimeout(r,0));assert.equal(persistentStorage().getItem('pi-theme'),'light','stale read cannot undo local write');
  stop();
  values={};window.localStorage.clear();window.localStorage.setItem('pi-theme','invalid-old-theme');window.localStorage.setItem('que:sound-enabled','false');
  offline=true;const stopRetry=await startSettingsSync();assert.deepEqual(values,{});
  offline=false;await poll();await new Promise(r=>setTimeout(r,0));
  assert.equal(values.theme,'auto','invalid stored preference cannot poison initialization');
  assert.equal(values.soundEnabled,false,'initialization retries after backend restart');
  stopRetry();
 }finally{globalThis.setInterval=originalInterval;globalThis.clearInterval=originalClear;dom.window.close();await rm(dir,{recursive:true,force:true});}
});
