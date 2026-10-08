import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
test('after an owner crash the card shows its acpx record and nothing is re-executed',async()=>{
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
  await rpc({action:'ensure',id:'card',cwd:root,agent:'fixture'});
  await rpc({action:'send',id:'card',requestId:'hold',text:'permission'});
  let decision;
  for(let i=0;i<100&&!decision;i++){decision=(await rpc({action:'read',id:'card'})).turns[0].blocks.find(b=>b.type==='decision');if(!decision)await sleep(30)}
  assert.ok(decision);
  assert.equal((await rpc({action:'send',id:'card',requestId:'queued',text:'never sent to the agent'})).state,'queued');
  const before=await rpc({action:'read',id:'card'});
  process.kill(Number(readFileSync(path.join(root,'owner.pid'),'utf8')),'SIGKILL');killAgents();
  await sleep(150);
  rpc=connect();
  // The conversation is the acpx record: what reached the agent is there,
  // what was only queued in the dead owner is gone, and nothing runs again.
  const after=await rpc({action:'read',id:'card'});
  assert.notEqual(after.ownerEpoch,before.ownerEpoch);
  assert.equal(after.state,'not_running');
  assert.ok(after.turns.some(t=>t.text==='permission'));
  assert.ok(!after.turns.some(t=>t.text==='never sent to the agent'));
  assert.ok(after.turns.every(t=>t.state==='history'));
  const next=await rpc({action:'send',id:'card',requestId:'after-crash',text:'continue'});
  let done;for(let i=0;i<200&&done?.state!=='completed';i++){done=(await rpc({action:'read',id:'card'})).turns.find(t=>t.id===next.id);if(done?.state!=='completed')await sleep(40)}
  assert.equal(done.state,'completed');
 }finally{
  relays.forEach(c=>c.kill());
  try{process.kill(Number(readFileSync(path.join(root,'owner.pid'),'utf8')))}catch{}
  for(let i=0;i<240&&existsSync(path.join(root,'owner.pid'));i++)await sleep(50);
  killAgents();assert.equal(existsSync(path.join(root,'owner.pid')),false);
  rmSync(root,{recursive:true,force:true});
 }
});
