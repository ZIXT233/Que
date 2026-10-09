import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync,openSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
async function until(predicate,ms=10000){for(let i=0;i<ms/25;i++){if(await predicate())return true;await sleep(25);}return predicate();}

// tmux only keeps the `--serve` owner alive on the remote host; a detached
// process stands in for it here. Que reaches it through `--connect`.
function setup(){
  const root=mkdtempSync(path.join(os.tmpdir(),'queacp-keep-'));
  writeFileSync(path.join(root,'agents.json'),JSON.stringify({fixture:[process.execPath,path.resolve('tests/acp/agent.mjs')]}));
  const env={...process.env,QUEACP_ACP_ROOT:root,QUEACP_ACP_STORE_DIR:path.join(root,'acpx')};
  return {root,env};
}
function daemon(bundle,env){
  const log=openSync(path.join(env.QUEACP_ACP_ROOT,'owner.log'),'a');
  const child=spawn(process.execPath,[bundle,'--serve'],{env,stdio:['ignore',log,log],detached:true});child.unref();return child;
}
function relay(bundle,env,args=['--connect']){
  const child=spawn(process.execPath,[bundle,...args],{env,stdio:['pipe','pipe','pipe']});
  child.stderr.on('data',d=>process.stderr.write('relay: '+d));
  const pending=new Map();let serial=0;child.stdin.on('error',()=>{});
  readline.createInterface({input:child.stdout}).on('line',line=>{const v=JSON.parse(line),p=pending.get(v.rpc);if(p){pending.delete(v.rpc);v.error?p.reject(Error(v.error)):p.resolve(v.result)}});
  const exited=new Promise(resolve=>child.on('exit',code=>{for(const p of pending.values())p.reject(Error('relay ended'));resolve(code)}));
  const rpc=body=>new Promise((resolve,reject)=>{const id=String(++serial);pending.set(id,{resolve,reject});child.stdin.write(JSON.stringify({...body,rpc:id})+'\n')});
  return {child,rpc,exited};
}
const bundle=path.resolve('src-tauri/resources/bin/acp-owner.mjs');
const stopDaemon=async root=>{const file=path.join(root,'owner.pid');if(existsSync(file))try{process.kill(Number(readFileSync(file,'utf8')))}catch{};await until(()=>!existsSync(file));};

test('a remote owner keeps working when Que disconnects, and Que picks up where it was', async()=>{
  const {root,env}=setup();
  try{
    assert.equal(await relay(bundle,env).exited,3,'no owner yet: the launcher must start one');
    daemon(bundle,env);
    let que=relay(bundle,env,['--connect','--wait']);
    await que.rpc({action:'ensure',id:'card',cwd:root,agent:'fixture'});
    await que.rpc({action:'send',id:'card',requestId:'hold',text:'permission'});
    let decision;
    await until(async()=>(decision=(await que.rpc({action:'read',id:'card'})).turns.at(-1)?.blocks.find(b=>b.type==='decision')));
    assert.ok(decision);
    que.child.kill();await que.exited;
    await sleep(300);
    que=relay(bundle,env);
    const after=await que.rpc({action:'read',id:'card'});
    assert.equal(after.turns.at(-1).blocks.find(b=>b.type==='decision').id,decision.id,'the turn waited for us');
    await que.rpc({action:'answer',id:'card',decisionId:decision.id,answer:{outcome:'reject_once'}});
    assert.ok(await until(async()=>(await que.rpc({action:'read',id:'card'})).turns.at(-1).state==='completed'));
    que.child.kill();await que.exited;
  }finally{await stopDaemon(root);rmSync(root,{recursive:true,force:true});}
});

test('a new build replaces an idle remote owner, and never interrupts a busy one', async()=>{
  const {root,env}=setup();
  const next=path.join(root,'next.mjs');
  writeFileSync(next,readFileSync(bundle,'utf8')+'\n// next build\n');
  try{
    daemon(bundle,env);
    let que=relay(bundle,env,['--connect','--wait']);
    await que.rpc({action:'ensure',id:'card',cwd:root,agent:'fixture'});
    await que.rpc({action:'send',id:'card',requestId:'hold',text:'permission'});
    await until(async()=>(await que.rpc({action:'read',id:'card'})).turns.at(-1)?.blocks.some(b=>b.type==='decision'));
    const busyPid=Number(readFileSync(path.join(root,'owner.pid'),'utf8'));
    const upgraded=relay(next,env);
    assert.equal((await upgraded.rpc({action:'read',id:'card'})).id,'card','a busy owner keeps serving the new build');
    assert.ok(alive(busyPid));
    upgraded.child.kill();await upgraded.exited;
    const decision=(await que.rpc({action:'read',id:'card'})).turns.at(-1).blocks.find(b=>b.type==='decision');
    await que.rpc({action:'answer',id:'card',decisionId:decision.id,answer:{outcome:'reject_once'}});
    assert.ok(await until(async()=>(await que.rpc({action:'read',id:'card'})).turns.at(-1).state==='completed'));
    que.child.kill();await que.exited;
    const code=await relay(next,env).exited;
    assert.equal(code,4,'an idle owner of another build is stopped; owner log: '+readFileSync(path.join(root,'owner.log'),'utf8'));
    assert.ok(await until(()=>!alive(busyPid)),'the old owner exited');
    assert.equal(existsSync(path.join(root,'owner.pid')),false);
  }finally{await stopDaemon(root);rmSync(root,{recursive:true,force:true});}
});
