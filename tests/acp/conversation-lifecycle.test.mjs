import { JSDOM } from 'jsdom';
import { build } from 'esbuild';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost'});
for(const key of ['window','document','HTMLElement','Element','Node','Event','MouseEvent','MutationObserver','sessionStorage'])globalThis[key]=dom.window[key];
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
globalThis.requestAnimationFrame=fn=>setTimeout(fn,0);
const channels=[];const NativeChannel=globalThis.MessageChannel;
globalThis.MessageChannel=class extends NativeChannel{constructor(){super();channels.push(this)}};
const result=await build({stdin:{contents:`
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import assert from 'node:assert/strict';
import {AcpConversation} from './src/components/AcpConversation';
import {admissionId,acknowledgeAdmission} from './src/lib/acp-admission';
const requests=[];
globalThis.fetch=(url,options)=>new Promise((resolve,reject)=>requests.push({url,body:options?.body&&JSON.parse(options.body),resolve:result=>resolve({ok:true,json:async()=>result}),reject}));
const root=createRoot(document.getElementById('root'));
const card={id:'first',cwd:'/project',workspaceId:'local',harness:{kind:'fixture'},session:null};
const render=async(key='deck',active=true,current=card)=>act(async()=>root.render(<AcpConversation key={key} card={current} active={active} onResume={async()=>{}}/>));
const turn=(id,text,state='completed')=>({id,text,state,attachments:[],blocks:[]});
const answer=async(req,value)=>act(async()=>req.resolve(value));
const takeSend=async()=>{
 for(let i=0;i<100;i++){
  const index=requests.findIndex(request=>request.body?.action==='send');
  if(index>=0)return requests.splice(index,1)[0];
  await act(async()=>new Promise(resolve=>setTimeout(resolve,10)));
 }
 throw Error('send was not dispatched');
};
export async function run(){
 const receipt=await admissionId('reload','private message',[]);
 assert.equal(await admissionId('reload','private message',[]),receipt,'a lost acknowledgement survives view reload');
 assert.doesNotMatch(sessionStorage.getItem('flat:admission:reload'),/private message/,'the receipt is not a second transcript');
 acknowledgeAdmission('reload','another-request');assert.equal(await admissionId('reload','private message',[]),receipt);
 acknowledgeAdmission('reload',receipt);assert.notEqual(await admissionId('reload','private message',[]),receipt,'an acknowledged identical message is a new submission');
 await render();assert.ok(document.querySelector('.cq-acp-loading'));
 await answer(requests.shift(),{state:'attention',turns:[turn('one','existing history')]});
 assert.equal(document.querySelector('.cq-acp-loading'),null);
 await render('inspection');assert.match(document.body.textContent,/existing history/);assert.equal(document.querySelector('.cq-acp-loading'),null,'moving the card retains history before any GET resolves');
 await answer(requests.shift(),{state:'starting',turns:[turn('one','existing history')]});
 assert.equal(document.querySelector('.cq-acp-loading'),null,'reconnect is not a history load');assert.equal(globalThis.__composer.busy,false);
 await act(async()=>globalThis.__composer.onDraft('next task'));
 await act(async()=>globalThis.__composer.onSend());const submission=await takeSend();assert.equal(submission.body.action,'send');
 await render('deck-again');assert.equal(globalThis.__composer.sending,true);assert.equal(globalThis.__composer.draft,'next task');
 const stalePoll=requests.shift();
 await answer(submission,turn(submission.body.requestId,'next task','running'));
 assert.equal(globalThis.__composer.sending,false);assert.equal(globalThis.__composer.draft,'','old component completion updates the new view');assert.match(document.body.textContent,/next task/);
 await act(async()=>stalePoll.reject(Error('old transport failed')));
 assert.equal(document.querySelector('[role=alert]'),null,'old poll failure cannot invalidate accepted send');
 assert.equal(globalThis.__composer.running,true);
 await render('other',true,{...card,id:'other'});assert.ok(document.querySelector('.cq-acp-loading'));assert.doesNotMatch(document.body.textContent,/existing history/);
 await answer(requests.shift(),{state:'attention',turns:[]});
 await act(async()=>globalThis.__composer.onDraft('uncertain task'));
 await act(async()=>globalThis.__composer.onSend());const lost=await takeSend();
 await act(async()=>lost.reject(Error('response lost')));
 await render('other-remounted',true,{...card,id:'other'});
 await answer(requests.shift(),{state:'attention',turns:[]});
 await act(async()=>globalThis.__composer.onSend());const retry=await takeSend();
 assert.equal(retry.body.requestId,lost.body.requestId,'retry after card move uses the original admission');
 await answer(retry,turn(retry.body.requestId,'uncertain task','running'));
 assert.equal(document.querySelector('[role=alert]'),null);
 await render('empty-receipts',true,{...card,id:'empty-receipts'});
 await answer(requests.shift(),{state:'attention',turns:[turn('legacy-a','','unknown'),turn('legacy-b','','unknown'),{...turn('reply-only',''),blocks:[{type:'text_delta',stream:'message',text:'Recovered agent reply'}]},turn('real-unknown','Actual uncertain input','unknown')]});
 assert.equal(document.querySelectorAll('.cq-acp-user').length,1,'only actual user content renders a bubble');
 assert.equal(document.querySelectorAll('.cq-acp-missing-receipts').length,1,'missing receipts are grouped once');
 assert.equal(document.querySelectorAll('.cq-acp-turn').length,2);
 assert.match(document.body.textContent,/Recovered agent reply/);assert.match(document.body.textContent,/Actual uncertain input/);
 await act(async()=>document.querySelector('.cq-acp-missing-receipts button').click());
 assert.equal(document.querySelector('.cq-acp-missing-receipts'),null,'dismiss removes the notice rather than just collapsing it');
 await render('empty-receipts-remounted',true,{...card,id:'empty-receipts'});
 assert.equal(document.querySelector('.cq-acp-missing-receipts'),null,'dismissal survives a component remount');
 await answer(requests.shift(),{state:'attention',turns:[turn('legacy-a','','unknown'),turn('legacy-b','','unknown')]});
 assert.equal(document.querySelector('.cq-acp-missing-receipts'),null,'polling cannot resurrect dismissed receipts');
 await render('new-missing-receipt',true,{...card,id:'empty-receipts'});
 await answer(requests.shift(),{state:'attention',turns:[turn('legacy-a','','unknown'),turn('legacy-b','','unknown'),turn('legacy-c','','unknown')]});
 assert.ok(document.querySelector('.cq-acp-missing-receipts'),'a new missing receipt still gets a notice');
 await render('separate-receipts',true,{...card,id:'separate-receipts'});
 await answer(requests.shift(),{state:'attention',turns:[turn('legacy-a','','unknown')]});
 assert.ok(document.querySelector('.cq-acp-missing-receipts'),'dismissal is scoped to one conversation');
 const healthCard={...card,id:'poll-health'};
 const healthy={state:'attention',turns:[turn('history','Kept history')],status:{models:{currentModelId:'small',availableModelIds:['small','large']}}};
 await render('health-start',true,healthCard);await answer(requests.shift(),healthy);
 await render('health-transient',true,healthCard);
 await act(async()=>requests.shift().reject(Error('brief read failure')));
 assert.equal(document.querySelector('[role=alert]'),null,'one failed poll is not a disconnection');
 assert.equal(globalThis.__composer.models.currentModelId,'small');
 assert.equal(globalThis.__composer.disconnected,false);
 assert.match(document.body.textContent,/Kept history/);
 await render('health-reset',true,healthCard);await answer(requests.shift(),healthy);
 for(let i=0;i<3;i++){
   await render('health-failure-'+i,true,healthCard);
   await act(async()=>requests.shift().reject(Error('read unavailable')));
   assert.equal(!!document.querySelector('[role=alert]'),i===2,'only sustained read failure shows a notice');
 }
 assert.equal(globalThis.__composer.models.currentModelId,'small','a warning never erases model information');
 assert.equal(document.querySelector('.cq-acp-loading'),null);
 await render('health-recovered',true,healthCard);await answer(requests.shift(),healthy);
 assert.equal(document.querySelector('[role=alert]'),null);
 await act(async()=>globalThis.__composer.onConfig({id:'__legacy_model'},'large'));
 const config=requests.shift();assert.equal(config.body.action,'model');
 await render('health-pending-model',true,healthCard);
 assert.equal(requests.length,0,'polling pauses during a configuration mutation');
 await answer(config,{...healthy,status:{models:{currentModelId:'large',availableModelIds:['small','large']}}});
 assert.equal(globalThis.__composer.models.currentModelId,'large');
 assert.equal(document.querySelector('[role=alert]'),null);
 await render('original',false);assert.match(document.body.textContent,/existing history/);assert.match(document.body.textContent,/next task/);
 await act(async()=>root.unmount());
 console.log('PASS: initial load, reconnect, remount during send, stale poll failure, isolated card histories');
}

`,loader:'tsx',resolveDir:process.cwd()},bundle:true,write:false,platform:'node',format:'esm',jsx:'automatic',loader:{'.css':'empty'},plugins:[{name:'view-fixtures',setup(b){
 b.onLoad({filter:/components\/chat\/Composer.tsx$/},()=>({contents:'export function Composer(props){globalThis.__composer=props;return null}',loader:'tsx'}));
 b.onLoad({filter:/hooks\/useI18n.tsx$/},()=>({contents:'export function useI18n(){return {t:key=>key}}',loader:'js'}));
}}],banner:{js:"import {createRequire} from 'node:module';const require=createRequire(import.meta.url);"}});
const dir=await mkdtemp(join(tmpdir(),'flat-conversation-'));
try{const file=join(dir,'test.mjs');await writeFile(file,result.outputFiles[0].text);await(await import(pathToFileURL(file))).run();}
finally{dom.window.close();channels.forEach(c=>{c.port1.close();c.port2.close()});await rm(dir,{recursive:true,force:true})}
