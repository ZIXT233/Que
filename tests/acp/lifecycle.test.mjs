import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
test('owner upgrades only when idle and shuts down cleanly', async()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'flat-lifecycle-'));
 const bundle=readFileSync('src-tauri/resources/bin/flat-acp.mjs','utf8');
 writeFileSync(path.join(root,'v1.mjs'),bundle);writeFileSync(path.join(root,'v2.mjs'),bundle+'\n// next build\n');
 writeFileSync(path.join(root,'agents.json'),JSON.stringify({fixture:[process.execPath,path.resolve('tests/acp/agent.mjs')]}));
 const children=[];let serial=0;
 function connect(version){
  const child=spawn(process.execPath,[path.join(root,version+'.mjs')],{env:{...process.env,FLAT_TEST_EMPTY_ROLLOUT:path.join(root,'rollout'),FLAT_ACP_ROOT:root,FLAT_ACP_STORE_DIR:path.join(root,'acpx')},stdio:['pipe','pipe','pipe']});children.push(child);
  let error='';child.stderr.on('data',d=>error+=d);const pending=new Map();
  readline.createInterface({input:child.stdout}).on('line',line=>{const v=JSON.parse(line);const p=pending.get(v.rpc);if(p){pending.delete(v.rpc);v.error?p.reject(Error(v.error)):p.resolve(v.result)}});
  child.on('exit',()=>{for(const p of pending.values())p.reject(Error(error||'relay exited'));pending.clear()});child.stdin.on('error',()=>{});
  return {child,rpc:body=>new Promise((resolve,reject)=>{const rpc=String(++serial);pending.set(rpc,{resolve,reject});child.stdin.write(JSON.stringify({...body,rpc})+'\n')})};
 }
 try {
  const a=connect('v1');const old=await a.rpc({action:'_hello'});const pid1=readFileSync(path.join(root,'owner.pid'),'utf8');
  await a.rpc({action:'ensure',id:'card',agent:'fixture',cwd:root});a.child.kill();
  const b=connect('v2');const fresh=await b.rpc({action:'_hello'});assert.notEqual(fresh.buildId,old.buildId);assert.notEqual(readFileSync(path.join(root,'owner.pid'),'utf8'),pid1);
  await b.rpc({action:'ensure',id:'card',agent:'fixture',cwd:root});await b.rpc({action:'send',id:'card',requestId:'approval',text:'permission'});
  let decision;for(let i=0;i<100&&!decision;i++){decision=(await b.rpc({action:'read',id:'card'})).turns[0].blocks.find(x=>x.type==='decision');if(!decision)await sleep(40)}assert.ok(decision);
  const busyPid=readFileSync(path.join(root,'owner.pid'),'utf8');const rejected=connect('v1');assert.equal((await rejected.rpc({action:'_hello'})).buildId,fresh.buildId);assert.equal(readFileSync(path.join(root,'owner.pid'),'utf8'),busyPid);
  assert.equal((await b.rpc({action:'read',id:'card'})).turns[0].blocks.find(x=>x.type==='decision').id,decision.id);
  await b.rpc({action:'answer',id:'card',decisionId:decision.id,answer:{outcome:'reject_once'}});
  let done=false;for(let i=0;i<100&&!done;i++){done=(await b.rpc({action:'read',id:'card'})).turns[0].state==='completed';if(!done)await sleep(40)}assert.ok(done);
  await b.rpc({action:'close',id:'card'});rmSync(path.join(root,'rollout'));
  await b.rpc({action:'ensure',id:'card',agent:'fixture',cwd:root});
  await b.rpc({action:'send',id:'card',requestId:'must-not-replace',text:'check existing history'});
  let failed;for(let i=0;i<100;i++){failed=(await b.rpc({action:'read',id:'card'})).turns.find(t=>t.id==='must-not-replace');if(failed.state==='failed')break;await sleep(40)}
  assert.equal(failed.state,'failed');assert.match(JSON.stringify(failed),/could not be resumed/);

 } finally {
  for(const c of children)c.kill();
  try{process.kill(Number(readFileSync(path.join(root,'owner.pid'),'utf8')))}catch{}
  for(let i=0;i<240&&existsSync(path.join(root,'owner.pid'));i++)await sleep(50);
  assert.equal(existsSync(path.join(root,'owner.pid')),false,'graceful shutdown removes owner identity');
  rmSync(root,{recursive:true,force:true});
 }
});
