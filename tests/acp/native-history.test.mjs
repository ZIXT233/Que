import {test} from 'node:test';
import {JSDOM} from 'jsdom';
import {build} from 'esbuild';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
test('native history selects agent, loads pages, filters active cards and opens exact native identity',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost'});
 for(const k of ['window','document','HTMLElement','Element','Node','Event','MouseEvent'])globalThis[k]=dom.window[k];
 globalThis.IS_REACT_ACT_ENVIRONMENT=true;
 const channels=[],NativeChannel=globalThis.MessageChannel;globalThis.MessageChannel=class extends NativeChannel{constructor(){super();channels.push(this);}};
 const dir=await mkdtemp(join(tmpdir(),'queacp-native-ui-'));
 try{
 const compiled=await build({stdin:{resolveDir:process.cwd(),loader:'tsx',contents:`
 import React,{act} from 'react';import {createRoot} from 'react-dom/client';import assert from 'node:assert/strict';
 import {NativeHistory} from './src/components/chat/NativeHistory';
 import {I18nProvider} from './src/hooks/useI18n';
 export async function run(){
  const urls=[],opened=[];globalThis.fetch=async url=>{urls.push(url);return {ok:true,json:async()=>url.includes('acp-catalog')?[{id:'codex',name:'Fixture'}]:{supported:true,sessions:url.includes('cursor=')?[{recordId:'native:codex:two',nativeSessionId:'two',title:'Second',agent:'codex'}]:[{recordId:'local',cardId:'active',title:'Hidden',agent:'codex'},{recordId:'native:codex:one',nativeSessionId:'one',title:'First',agent:'codex'}],...url.includes('cursor=')?{}:{nextCursor:'next'}}};};
  const root=createRoot(document.getElementById('root'));
  await act(async()=>root.render(<I18nProvider><NativeHistory workspace="workspace id" activeIds={['active']} search="" onOpen={e=>opened.push(e)}/></I18nProvider>));
  assert.match(urls[0],/workspace=workspace%20id/);
  const click=async text=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim().startsWith(text));assert.ok(b,text);await act(async()=>b.click());};
  assert.equal(urls.length,1);assert.ok(document.querySelector('.fc-agent-picker'));assert.ok(document.querySelector('.fc-agent-picker-options svg'));
  await click('Codex');assert.match(urls[1],/agent=codex/);assert.ok(!document.body.textContent.includes('Hidden'));
  assert.match(urls[2],/cursor=next/);assert.ok(document.body.textContent.includes('First'));assert.ok(document.body.textContent.includes('Second'));
  await act(async()=>[...document.querySelectorAll('button')].find(b=>b.textContent.startsWith('Second')).click());
  assert.equal(opened[0].nativeSessionId,'two');assert.equal(opened[0].agent,'codex');
  await act(async()=>root.render(<I18nProvider><NativeHistory activeIds={[]} search="" onOpen={e=>opened.push(e)}/></I18nProvider>));
  assert.equal(urls.at(-1),'/api/acp-catalog');
  await click('Codex');assert.ok(urls.includes('/api/acp-history?agent=codex'));
  assert.equal(document.querySelector('.fc-agent-picker').open,false);
  await act(async()=>root.unmount());
 }
 `},bundle:true,write:false,platform:'node',format:'esm',jsx:'automatic',banner:{js:"import {createRequire} from 'node:module';const require=createRequire(import.meta.url);"}});
 const file=join(dir,'run.mjs');await writeFile(file,compiled.outputFiles[0].text);await (await import(pathToFileURL(file))).run();
 }finally{for(const c of channels){c.port1.close();c.port2.close();}globalThis.MessageChannel=NativeChannel;dom.window.close();await rm(dir,{recursive:true,force:true});}
});
