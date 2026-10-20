import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

test('background connections retain idle agents, recover a dead process and never replay prompts', async()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'que-keepalive-'));
 writeFileSync(path.join(root,'agents.json'),JSON.stringify({fixture:[process.execPath,path.resolve('tests/acp/agent.mjs')]}));
 const child=spawn(process.execPath,['src-tauri/resources/bin/acp-owner.mjs'],{env:{...process.env,QUE_ACP_ROOT:root,QUE_ACP_STORE_DIR:path.join(root,'acpx')},stdio:['pipe','pipe','pipe']});
 let serial=0;const pending=new Map();
 readline.createInterface({input:child.stdout}).on('line',line=>{const v=JSON.parse(line),p=pending.get(v.rpc);if(p){pending.delete(v.rpc);v.error?p.reject(Error(v.error)):p.resolve(v.result)}});
 child.stderr.on('data',d=>process.stderr.write(d));
 const rpc=body=>new Promise((resolve,reject)=>{const rpc=String(++serial);pending.set(rpc,{resolve,reject});child.stdin.write(JSON.stringify({...body,rpc})+'\n')});
 const ensure=id=>rpc({action:'ensure',id,agent:'fixture',cwd:root});
 try {
  const cards=await Promise.all(['a','b','c'].map(ensure));
  assert.deepEqual(await rpc({action:'health'}),Object.fromEntries(['a','b','c'].map(id=>[id,{connected:true,busy:false}])));
  const stable=await ensure('a');assert.equal(stable.connectionId,cards[0].connectionId);assert.deepEqual(stable.turns,[]);
  await rpc({action:'send',id:'b',requestId:'only-once',text:'watch-hold'});
  assert.equal((await rpc({action:'health'})).b.busy,true);
  const record=JSON.parse(readFileSync(path.join(root,'acpx','sessions',encodeURIComponent(cards[0].recordId)+'.json'),'utf8'));
  process.kill(record.pid,'SIGKILL');
  for(let i=0;i<100 && (await rpc({action:'health'})).a.connected;i++)await sleep(20);
  assert.equal((await rpc({action:'health'})).a.connected,false);
  const recovered=await Promise.all([ensure('a'),ensure('a')]);
  assert.notEqual(recovered[0].connectionId,stable.connectionId);
  assert.equal(recovered[0].connectionId,recovered[1].connectionId,'concurrent reconnects share one startup');
  assert.deepEqual(recovered[0].turns,[],'warmup does not create a user turn');
  await rpc({action:'close',id:'a',expectedConnectionId:stable.connectionId});
  assert.equal((await rpc({action:'health'})).a.connected,true,'stale cleanup cannot close a newer connection');
  await rpc({action:'close',id:'a',expectedConnectionId:recovered[0].connectionId});
  assert.equal((await rpc({action:'health'})).a,undefined);
  for(let i=0;i<100 && (await rpc({action:'health'})).b.busy;i++)await sleep(30);
  const b=await rpc({action:'read',id:'b'});assert.equal(b.turns.length,1);assert.equal(b.turns[0].state,'completed');
  assert.equal((await ensure('b')).turns.length,1);
  assert.equal((await rpc({action:'health'})).c.connected,true,'unviewed idle cards remain connected');
 } finally {
  child.kill();
  try{process.kill(Number(readFileSync(path.join(root,'owner.pid'),'utf8')))}catch{}
  for(let i=0;i<240&&existsSync(path.join(root,'owner.pid'));i++)await sleep(50);
  assert.equal(existsSync(path.join(root,'owner.pid')),false);
  rmSync(root,{recursive:true,force:true});
 }
});
