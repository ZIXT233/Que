import { installEventSource } from './event-source.mjs';
import { JSDOM } from 'jsdom';
import { build } from 'esbuild';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost'});
for(const key of ['window','document','HTMLElement','HTMLImageElement','Element','Node','Event','MouseEvent','MutationObserver','sessionStorage'])globalThis[key]=dom.window[key];
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
globalThis.__streams=installEventSource();
globalThis.requestAnimationFrame=fn=>setTimeout(fn,0);
globalThis.ResizeObserver=class{observe(){}disconnect(){}};
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
// The card on screen: what the shared stream delivers is for it.
let shown=card.id;
// Opening a card the stream has not delivered reads it once; this returns how
// many reads the opening made, and leaves them unanswered.
const render=async(key='deck',active=true,current=card)=>{
 shown=current.id;
 await act(async()=>root.render(<AcpConversation key={key} card={current} active={active} onResume={async()=>{}}/>));
 const reads=requests.filter(request=>!request.body);
 for(const read of reads)requests.splice(requests.indexOf(read),1);
 await act(async()=>reads.forEach(read=>read.reject(Error('not answered in this test'))));
 return reads.length;
};
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
 const streams=globalThis.__streams,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 // The conversation is a subscription: a test pushes what the stream would deliver.
 const push=async data=>act(async()=>{streams.latest().emit('snapshot',data,shown);await sleep(30)});
 const pushDelta=async data=>act(async()=>{streams.latest().emit('delta',data,shown);await sleep(30)});
 const receipt=await admissionId('reload','private message',[]);
 assert.equal(await admissionId('reload','private message',[]),receipt,'a lost acknowledgement survives view reload');
 assert.doesNotMatch(sessionStorage.getItem('que:admission:reload'),/private message/,'the receipt is not a second transcript');
 acknowledgeAdmission('reload','another-request');assert.equal(await admissionId('reload','private message',[]),receipt);
 acknowledgeAdmission('reload',receipt);assert.notEqual(await admissionId('reload','private message',[]),receipt,'an acknowledged identical message is a new submission');
 await render();assert.ok(document.querySelector('.cq-acp-loading'));
 await push({state:'attention',turns:[turn('one','existing history')]});
 assert.equal(document.querySelector('.cq-acp-loading'),null);
 await render('inspection');assert.match(document.body.textContent,/existing history/);assert.equal(document.querySelector('.cq-acp-loading'),null,'moving the card retains history before any GET resolves');
 await push({state:'starting',turns:[turn('one','existing history')]});
 assert.equal(document.querySelector('.cq-acp-loading'),null,'reconnect is not a history load');assert.equal(globalThis.__composer.busy,false);
 await act(async()=>globalThis.__composer.onDraft('next task'));
 await act(async()=>globalThis.__composer.onSend());const submission=await takeSend();assert.equal(submission.body.action,'send');
 await render('deck-again');assert.equal(globalThis.__composer.sending,true);assert.equal(globalThis.__composer.draft,'next task');
 await answer(submission,turn(submission.body.requestId,'next task','running'));
 assert.equal(globalThis.__composer.sending,false);assert.equal(globalThis.__composer.draft,'','old component completion updates the new view');assert.match(document.body.textContent,/next task/);
 await act(async()=>streams.latest().fail());
 assert.equal(document.querySelector('[role=alert]'),null,'a failure of the stream cannot invalidate an accepted send');
 assert.equal(globalThis.__composer.running,true);
 await render('other',true,{...card,id:'other'});assert.ok(document.querySelector('.cq-acp-loading'));assert.doesNotMatch(document.body.textContent,/existing history/);
 await push({state:'attention',turns:[]});
 await act(async()=>globalThis.__composer.onDraft('uncertain task'));
 await act(async()=>globalThis.__composer.onSend());const lost=await takeSend();
 await act(async()=>lost.reject(Error('response lost')));
 await render('other-remounted',true,{...card,id:'other'});
 await push({state:'attention',turns:[]});
 await act(async()=>globalThis.__composer.onSend());const retry=await takeSend();
 assert.equal(retry.body.requestId,lost.body.requestId,'retry after card move uses the original admission');
 await answer(retry,turn(retry.body.requestId,'uncertain task','running'));
 assert.equal(document.querySelector('[role=alert]'),null);
 await render('empty-receipts',true,{...card,id:'empty-receipts'});
 await push({state:'attention',turns:[turn('legacy-a','','unknown'),turn('legacy-b','','unknown'),{...turn('reply-only',''),blocks:[{type:'text_delta',stream:'message',text:'Recovered agent reply'}]},turn('real-unknown','Actual uncertain input','unknown')]});
 assert.equal(document.querySelectorAll('.cq-acp-user').length,1,'only actual user content renders a bubble');
 assert.equal(document.querySelectorAll('.cq-acp-missing-receipts').length,1,'missing receipts are grouped once');
 assert.equal(document.querySelectorAll('.cq-acp-turn').length,2);
 assert.match(document.body.textContent,/Recovered agent reply/);assert.match(document.body.textContent,/Actual uncertain input/);
 await act(async()=>document.querySelector('.cq-acp-missing-receipts button').click());
 assert.equal(document.querySelector('.cq-acp-missing-receipts'),null,'dismiss removes the notice rather than just collapsing it');
 await render('empty-receipts-remounted',true,{...card,id:'empty-receipts'});
 assert.equal(document.querySelector('.cq-acp-missing-receipts'),null,'dismissal survives a component remount');
 await push({state:'attention',turns:[turn('legacy-a','','unknown'),turn('legacy-b','','unknown')]});
 assert.equal(document.querySelector('.cq-acp-missing-receipts'),null,'a later snapshot cannot resurrect dismissed receipts');
 await render('new-missing-receipt',true,{...card,id:'empty-receipts'});
 await push({state:'attention',turns:[turn('legacy-a','','unknown'),turn('legacy-b','','unknown'),turn('legacy-c','','unknown')]});
 assert.ok(document.querySelector('.cq-acp-missing-receipts'),'a new missing receipt still gets a notice');
 await render('separate-receipts',true,{...card,id:'separate-receipts'});
 await push({state:'attention',turns:[turn('legacy-a','','unknown')]});
 assert.ok(document.querySelector('.cq-acp-missing-receipts'),'dismissal is scoped to one conversation');
 const healthCard={...card,id:'stream-health'};
 const healthy={ownerEpoch:'e',revision:10,state:'attention',turns:[turn('history','Kept history')],status:{models:{currentModelId:'small',availableModelIds:['small','large']}}};
 await render('health-start',true,healthCard);await push(healthy);
 await render('health-transient',true,healthCard);
 await act(async()=>streams.latest().fail());
 assert.equal(document.querySelector('[role=alert]'),null,'one failed connection attempt is not a disconnection');
 assert.equal(globalThis.__composer.models.currentModelId,'small');
 assert.equal(globalThis.__composer.disconnected,false);
 assert.match(document.body.textContent,/Kept history/);
 await render('health-reset',true,healthCard);await push(healthy);
 for(let i=0;i<3;i++){
   await render('health-failure-'+i,true,healthCard);
   await act(async()=>streams.latest().fail());
   assert.equal(!!document.querySelector('[role=alert]'),i===2,'only a sustained stream failure shows a notice');
 }
 assert.equal(globalThis.__composer.models.currentModelId,'small','a warning never erases model information');
 assert.equal(document.querySelector('.cq-acp-loading'),null);
 await render('health-recovered',true,healthCard);await push(healthy);
 assert.equal(document.querySelector('[role=alert]'),null);
 await act(async()=>globalThis.__composer.onConfig({id:'__legacy_model'},'large'));
 const config=requests.shift();assert.equal(config.body.action,'model');
 assert.equal(await render('health-pending-model',true,healthCard),0,'a card the stream delivered is not read again');
 assert.equal(requests.length,0,'a mutation in flight causes no extra reads');
 await answer(config,{...healthy,revision:11,status:{models:{currentModelId:'large',availableModelIds:['small','large']}}});
 assert.equal(globalThis.__composer.models.currentModelId,'large');
 assert.equal(document.querySelector('[role=alert]'),null);
 await push(healthy);
 assert.equal(globalThis.__composer.models.currentModelId,'large','an older snapshot of the same owner cannot roll a confirmed change back');

 // Streaming: deltas extend the transcript, a delta that does not fit triggers one full read, a refused stream reconnects.
 assert.equal(await render('stream-start',true,{...card,id:'streaming'}),1,'a card the stream has not delivered yet is read once');
 const running={ownerEpoch:'e2',revision:1,state:'working',turns:[{id:'t',text:'go',state:'running',attachments:[],blocks:[{type:'text_delta',stream:'message',text:'Hel'}]}]};
 await push(running);assert.match(document.body.textContent,/Hel/);
 await pushDelta({epoch:'e2',base:1,rev:2,ops:[{op:'append',turn:'t',block:0,text:'lo'}]});
 assert.match(document.body.textContent,/Hello/);
 await act(async()=>{const source=streams.latest();
   source.emit('delta',{epoch:'e2',base:2,rev:3,ops:[{op:'append',turn:'t',block:0,text:' wor'}]},shown);
   source.emit('delta',{epoch:'e2',base:3,rev:4,ops:[{op:'append',turn:'t',block:0,text:'ld'}]},shown);await sleep(30)});
 assert.match(document.body.textContent,/Hello world/,'deltas arriving in one frame apply together');
 assert.equal(requests.length,0,'in-order deltas never cause a read');
 await pushDelta({epoch:'e2',base:9,rev:10,ops:[{op:'append',turn:'t',block:0,text:'!'}]});
 const resync=requests.splice(requests.findIndex(request=>!request.body),1)[0];
 assert.ok(resync,'a delta that does not fit triggers a full read');
 assert.doesNotMatch(document.body.textContent,/Hello world!/,'a delta that does not fit is never applied');
 await push({...running,revision:12,turns:[{...running.turns[0],blocks:[{type:'text_delta',stream:'message',text:'Recovered text'}]}]});
 await answer(resync,{...running,revision:12,turns:[{...running.turns[0],blocks:[{type:'text_delta',stream:'message',text:'Recovered text'}]}]});
 assert.match(document.body.textContent,/Recovered text/);
 await pushDelta({epoch:'e2',base:12,rev:13,ops:[{op:'append',turn:'t',block:0,text:'!'}]});
 assert.match(document.body.textContent,/Recovered text!/,'the stream continues from the repaired revision');
 assert.equal(requests.length,0);
 const refused=streams.latest(),before=streams.sources.length;
 await act(async()=>refused.fail(true));
 await act(async()=>sleep(1100));
 assert.equal(streams.sources.length,before+1,'a refused stream is reopened');assert.notEqual(streams.latest(),refused);
 await render('original',false);assert.match(document.body.textContent,/existing history/);assert.match(document.body.textContent,/next task/);
 await act(async()=>root.unmount());
 console.log('PASS: initial load, reconnect, remount during send, stream failure, isolated card histories, ordered deltas, resync and reconnect');
}

`,loader:'tsx',resolveDir:process.cwd()},bundle:true,write:false,platform:'node',format:'esm',jsx:'automatic',loader:{'.css':'empty'},plugins:[{name:'view-fixtures',setup(b){
 b.onLoad({filter:/components\/chat\/Composer.tsx$/},()=>({contents:'export function Composer(props){globalThis.__composer=props;return null}',loader:'tsx'}));
 b.onLoad({filter:/hooks\/useI18n.tsx$/},()=>({contents:'export function useI18n(){return {t:key=>key}}',loader:'js'}));
}}],banner:{js:"import {createRequire} from 'node:module';const require=createRequire(import.meta.url);"}});
const dir=await mkdtemp(join(tmpdir(),'que-conversation-'));
try{const file=join(dir,'test.mjs');await writeFile(file,result.outputFiles[0].text);await(await import(pathToFileURL(file))).run();}
finally{dom.window.close();channels.forEach(c=>{c.port1.close();c.port2.close()});await rm(dir,{recursive:true,force:true})}
