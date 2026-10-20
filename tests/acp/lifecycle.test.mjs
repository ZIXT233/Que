import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
test('a session that cannot be resumed fails visibly, and closing the pipe shuts down cleanly', async()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'que-lifecycle-'));
 writeFileSync(path.join(root,'agents.json'),JSON.stringify({fixture:[process.execPath,path.resolve('tests/acp/agent.mjs')]}));
 let serial=0;
 const child=spawn(process.execPath,['src-tauri/resources/bin/acp-owner.mjs'],{env:{...process.env,QUE_TEST_EMPTY_ROLLOUT:path.join(root,'rollout'),QUE_ACP_ROOT:root,QUE_ACP_STORE_DIR:path.join(root,'acpx')},stdio:['pipe','pipe','pipe']});
 let error='';child.stderr.on('data',d=>error+=d);const pending=new Map();
 readline.createInterface({input:child.stdout}).on('line',line=>{const v=JSON.parse(line);const p=pending.get(v.rpc);if(p){pending.delete(v.rpc);v.error?p.reject(Error(v.error)):p.resolve(v.result)}});
 child.on('exit',()=>{for(const p of pending.values())p.reject(Error(error||'owner exited'));pending.clear()});child.stdin.on('error',()=>{});
 const rpc=body=>new Promise((resolve,reject)=>{const id=String(++serial);pending.set(id,{resolve,reject});child.stdin.write(JSON.stringify({...body,rpc:id})+'\n')});
 try {
  await rpc({action:'ensure',id:'card',agent:'fixture',cwd:root});await rpc({action:'send',id:'card',requestId:'approval',text:'permission'});
  let decision;for(let i=0;i<100&&!decision;i++){decision=(await rpc({action:'read',id:'card'})).turns[0].blocks.find(x=>x.type==='decision');if(!decision)await sleep(40)}assert.ok(decision);
  await rpc({action:'answer',id:'card',decisionId:decision.id,answer:{outcome:'reject_once'}});
  let done=false;for(let i=0;i<100&&!done;i++){done=(await rpc({action:'read',id:'card'})).turns[0].state==='completed';if(!done)await sleep(40)}assert.ok(done);
  await rpc({action:'close',id:'card'});rmSync(path.join(root,'rollout'));
  await rpc({action:'ensure',id:'card',agent:'fixture',cwd:root});
  await rpc({action:'send',id:'card',requestId:'must-not-replace',text:'check existing history'});
  let failed;for(let i=0;i<500;i++){failed=(await rpc({action:'read',id:'card'})).turns.find(t=>t.id==='must-not-replace');if(failed.state==='failed')break;await sleep(40)}
  assert.equal(failed.state,'failed');assert.match(JSON.stringify(failed),/could not be resumed/);
 } finally {
  child.stdin.end();
  for(let i=0;i<240&&existsSync(path.join(root,'owner.pid'));i++)await sleep(50);
  assert.equal(existsSync(path.join(root,'owner.pid')),false,'graceful shutdown releases the data directory');
  rmSync(root,{recursive:true,force:true});
 }
});
