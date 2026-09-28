import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
test('owner crash preserves pending input and withdrawal without re-executing it',async()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'flat-crash-'));
 const pidFile=path.join(root,'fixture-pids');
 writeFileSync(path.join(root,'agents.json'),JSON.stringify({fixture:[process.execPath,path.resolve('tests/acp/agent.mjs')]}));
 const relays=[];let serial=0;
 const killAgents=()=>{if(existsSync(pidFile))for(const pid of readFileSync(pidFile,'utf8').trim().split('\n'))try{process.kill(Number(pid),'SIGKILL')}catch{}};
 function connect(){
  const child=spawn(process.execPath,['src-tauri/resources/bin/flat-acp.mjs'],{env:{...process.env,FLAT_ACP_ROOT:root,FLAT_ACP_STORE_DIR:path.join(root,'acpx'),FLAT_TEST_PID_FILE:pidFile},stdio:['pipe','pipe','pipe']});relays.push(child);
  const pending=new Map();let errors='';child.stderr.on('data',d=>errors+=d);child.stdin.on('error',()=>{});
  readline.createInterface({input:child.stdout}).on('line',line=>{const v=JSON.parse(line),p=pending.get(v.rpc);if(p){pending.delete(v.rpc);v.error?p.reject(Error(v.error)):p.resolve(v.result)}});
  child.on('exit',()=>{for(const p of pending.values())p.reject(Error(errors||'relay ended'));pending.clear()});
  return body=>new Promise((resolve,reject)=>{const rpc=String(++serial);pending.set(rpc,{resolve,reject});child.stdin.write(JSON.stringify({...body,rpc})+'\n')});
 }
 try{
  let rpc=connect();
  const ready=await rpc({action:'ensure',id:'card',cwd:root,agent:'fixture'});
  await rpc({action:'send',id:'card',requestId:'hold',text:'permission'});
  let decision;
  for(let i=0;i<100&&!decision;i++){decision=(await rpc({action:'read',id:'card'})).turns[0].blocks.find(b=>b.type==='decision');if(!decision)await sleep(30)}
  assert.ok(decision);
  await rpc({action:'send',id:'card',requestId:'withdraw',text:'removed queued message'});
  await rpc({action:'cancel',id:'card',requestId:'withdraw',queuedOnly:true});
  const message={action:'send',id:'card',requestId:'pending',text:'keep my pending message',attachments:[{mediaType:'text/plain',name:'note.txt',data:'pending file'}]};
  assert.equal((await rpc(message)).state,'queued');
  const before=await rpc({action:'read',id:'card'});
  assert.ok(before.revision>ready.revision);
  const receipts=JSON.parse(readFileSync(path.join(root,'bindings.json'),'utf8')).card.receipts;
  assert.equal(receipts.find(r=>r.id==='pending').pending.text,message.text);
  assert.equal(receipts.find(r=>r.id==='hold').pending,undefined,'already persisted ACP messages are not duplicated');
  process.kill(Number(readFileSync(path.join(root,'owner.pid'),'utf8')),'SIGKILL');killAgents();
  await sleep(150);
  rpc=connect();
  const after=await rpc({action:'read',id:'card'});
  assert.notEqual(after.ownerEpoch,before.ownerEpoch);
  const restored=after.turns.find(t=>t.id==='pending');
  assert.equal(restored.text,message.text);assert.deepEqual(restored.attachments,message.attachments);assert.equal(restored.state,'unknown');
  assert.equal(after.turns.find(t=>t.id==='withdraw').withdrawn,true);
  assert.equal((await rpc(message)).state,'unknown','retry only returns receipt, never automatically executes uncertain work');
  assert.equal((await rpc({action:'read',id:'card'})).turns.filter(t=>t.id==='pending').length,1);
  process.kill(Number(readFileSync(path.join(root,'owner.pid'),'utf8')));
  for(let i=0;i<240&&existsSync(path.join(root,'owner.pid'));i++)await sleep(30);
  assert.equal(existsSync(path.join(root,'owner.pid')),false);
  rmSync(path.join(root,'acpx','sessions',encodeURIComponent(ready.recordId)+'.json'));
  rpc=connect();
  await assert.rejects(rpc({action:'ensure',id:'card',agent:'fixture',cwd:root}),/不会自动创建新会话/);
  assert.equal((await rpc({action:'read',id:'card'})).turns.find(t=>t.id==='pending').text,message.text,'a missing record must not erase pending input');
 }finally{
  relays.forEach(c=>c.kill());
  try{process.kill(Number(readFileSync(path.join(root,'owner.pid'),'utf8')))}catch{}
  for(let i=0;i<240&&existsSync(path.join(root,'owner.pid'));i++)await sleep(50);
  killAgents();assert.equal(existsSync(path.join(root,'owner.pid')),false);
  rmSync(root,{recursive:true,force:true});
 }
});
