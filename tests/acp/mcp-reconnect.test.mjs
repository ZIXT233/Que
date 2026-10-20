import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import readline from 'node:readline';
import os from 'node:os';
import path from 'node:path';
const binary=process.env.QUE_HEADLESS_TEST_BINARY;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

test('a message to a disconnected card connects it, once per request', {skip:!binary}, async()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'que-mcp-reconnect-'));
 const child=spawn(binary,[root],{env:{...process.env,QUE_BIN_DIR:path.resolve('src-tauri/resources/bin'),QUE_ACP_STORE_DIR:path.join(root,'acpx')},stdio:['pipe','pipe','pipe']});
 let ownerPid;
 try {
  const {base,token:apiToken}=await new Promise((resolve,reject)=>{
   const lines=readline.createInterface({input:child.stdout});
   lines.on('line',line=>{try{const v=JSON.parse(line);if(v.base)resolve(v)}catch{}});
   child.once('exit',code=>reject(Error('headless exited '+code)));
   child.stderr.on('data',()=>{});
  });
  const data=path.join(root,'que'),cwd=path.join(root,'home');mkdirSync(cwd,{recursive:true});mkdirSync(path.join(data,'acp'),{recursive:true});
  writeFileSync(path.join(data,'acp','agents.json'),JSON.stringify({fixture:[process.execPath,path.resolve('tests/acp/agent.mjs')]}));
  const source='b071e000-0000-4000-8000-000000000001',target='test-target';
  const card=(id,permissions)=>({id,cwd,workspaceId:'home',permissions,phase:'attention',createdAt:0,harness:{kind:'fixture',terminalId:id,state:'not_running'}});
  const queue={version:1,revision:0,order:[source,target],cards:[card(source,{allChannels:true}),card(target)],workspaces:[{id:'home',name:'Home',kind:'local',cwd,runtimeCwd:cwd}]};
  writeFileSync(path.join(data,'queue.json'),JSON.stringify(queue));
  const post=async(url,body,headers={})=>{
   const r=await fetch(base+url,{method:'POST',headers:{'Content-Type':'application/json','x-que-token':apiToken,...headers},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
   const value=await r.json();if(!r.ok)throw Error(JSON.stringify(value));return value;
  };
  const api=(id,body)=>post('/api/acp/'+id,body);
  const sourceSession=await api(source,{action:'ensure',agent:'fixture',cwd});
  ownerPid=Number(readFileSync(path.join(data,'acp','owner.pid'),'utf8'));
  const first=await api(target,{action:'ensure',agent:'fixture',cwd});
  await api(target,{action:'close'});
  const {token}=JSON.parse(readFileSync(path.join(data,'mcp','endpoint.json'),'utf8'));
  const headers={authorization:'Bearer '+token,'x-que-client-id':'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','x-que-source-terminal':source,'x-que-source-epoch':sourceSession.connectionId};
  const message={tool:'send_message',to:target,requestId:'once',text:'fixture message'};
  const submitted=await post('/api/mcp/tools',message,headers);
  assert.deepEqual(submitted.sent.map(c=>c.cardId),[target]);
  let snapshot;
  for(let i=0;i<400;i++){
   snapshot=await (await fetch(base+'/api/acp/'+target,{headers:{'x-que-token':apiToken}})).json();
   if(snapshot.turns[0]?.state==='completed')break;await sleep(30);
  }
  assert.equal(snapshot.turns.length,1);assert.equal(snapshot.turns[0].state,'completed');
  assert.notEqual(snapshot.connectionId,first.connectionId);
  assert.deepEqual((await post('/api/mcp/tools',message,headers)).sent.map(c=>c.cardId),[target],'a retry is the same message');
  await sleep(1500);
  assert.equal((await (await fetch(base+'/api/acp/'+target,{headers:{'x-que-token':apiToken}})).json()).turns.length,1);
  await assert.rejects(post('/api/mcp/tools',{...message,requestId:'stale'}, {...headers,'x-que-source-epoch':'stale-source'}),/Source agent run ended/);
  await api(target,{action:'close'});
  queue.cards[1].archivedAt=1;writeFileSync(path.join(data,'queue.json'),JSON.stringify(queue));
  await assert.rejects(post('/api/mcp/tools',{...message,requestId:'archived'},headers),/archived/);
  assert.equal((await api(source,{action:'health'}))[target],undefined);
 } finally {
  child.stdin.end();
  if(ownerPid)try{process.kill(ownerPid)}catch{}
  for(let i=0;i<240&&existsSync(path.join(root,'que','acp','owner.pid'));i++)await sleep(50);
  child.kill();rmSync(root,{recursive:true,force:true});
 }
});
