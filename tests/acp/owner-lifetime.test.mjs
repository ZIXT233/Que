import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
async function until(predicate,ms=8000){for(let i=0;i<ms/25;i++){if(predicate())return true;await sleep(25);}return predicate();}

function start(root,pidFile,env={}){
  const child=spawn(process.execPath,['src-tauri/resources/bin/acp-owner.mjs'],{env:{...process.env,QUEACP_ACP_ROOT:root,QUEACP_ACP_STORE_DIR:path.join(root,'acpx'),QUEACP_TEST_PID_FILE:pidFile,...env},stdio:['pipe','pipe','pipe']});
  const pending=new Map();let serial=0,errors='';
  child.stderr.on('data',d=>errors+=d);child.stdin.on('error',()=>{});
  readline.createInterface({input:child.stdout}).on('line',line=>{const v=JSON.parse(line),p=pending.get(v.rpc);if(p){pending.delete(v.rpc);v.error?p.reject(Error(v.error)):p.resolve(v.result)}});
  child.on('exit',()=>{for(const p of pending.values())p.reject(Error(errors||'owner ended'));pending.clear()});
  const rpc=body=>new Promise((resolve,reject)=>{const id=String(++serial);pending.set(id,{resolve,reject});child.stdin.write(JSON.stringify({...body,rpc:id})+'\n')});
  return {child,rpc};
}
const agentPids=file=>existsSync(file)?readFileSync(file,'utf8').trim().split('\n').filter(Boolean).map(Number):[];

test('the owner and its agents end when the app closes the pipe, even mid-turn',async()=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'queacp-life-'));const pidFile=path.join(root,'fixture-pids');
  writeFileSync(path.join(root,'agents.json'),JSON.stringify({fixture:[process.execPath,path.resolve('tests/acp/agent.mjs')]}));
  try{
    // A stubborn agent proves the owner kills agents rather than relying on EOF.
    const {child,rpc}=start(root,pidFile,{QUEACP_TEST_IGNORE_EOF:'1'});
    await rpc({action:'ensure',id:'card',cwd:root,agent:'fixture'});
    await rpc({action:'send',id:'card',requestId:'hold',text:'permission'});
    const [agent]=agentPids(pidFile);assert.ok(agent&&alive(agent),'agent is running');
    assert.equal(Number(readFileSync(path.join(root,'owner.pid'),'utf8')),child.pid);
    child.stdin.end();
    assert.ok(await until(()=>child.exitCode!==null),'owner exits when its app goes away');
    assert.equal(child.exitCode,0,'graceful shutdown');
    assert.ok(await until(()=>!alive(agent)),'agent does not outlive the owner');
    assert.equal(existsSync(path.join(root,'owner.pid')),false,'ownership released');
    // The next owner starts cleanly and reports the interrupted turn honestly.
    const next=start(root,pidFile);
    const session=await next.rpc({action:'read',id:'card'});
    assert.equal(session.state,'not_running');
    assert.ok(session.turns.every(t=>t.state==='history'),'nothing from the interrupted run is still running');
    next.child.stdin.end();await until(()=>next.child.exitCode!==null);
  }finally{for(const pid of agentPids(pidFile))try{process.kill(pid,'SIGKILL')}catch{};rmSync(root,{recursive:true,force:true});}
});

test('a hard-killed owner leaves no agents behind once the next owner starts',{skip:process.platform!=='linux'&&'stale PIDs are only provable on Linux'},async()=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'queacp-life-'));const pidFile=path.join(root,'fixture-pids');
  writeFileSync(path.join(root,'agents.json'),JSON.stringify({fixture:[process.execPath,path.resolve('tests/acp/agent.mjs')]}));
  try{
    const first=start(root,pidFile,{QUEACP_TEST_IGNORE_EOF:'1'});
    await first.rpc({action:'ensure',id:'card',cwd:root,agent:'fixture'});
    const [agent]=agentPids(pidFile);assert.ok(alive(agent));
    first.child.kill('SIGKILL');await until(()=>first.child.exitCode!==null||first.child.signalCode!==null);
    assert.ok(alive(agent),'precondition: the agent survived its owner');
    const second=start(root,pidFile);
    await second.rpc({action:'read',id:'card'});
    assert.ok(await until(()=>!alive(agent)),'stale agent reaped');
    second.child.stdin.end();await until(()=>second.child.exitCode!==null);
  }finally{for(const pid of agentPids(pidFile))try{process.kill(pid,'SIGKILL')}catch{};rmSync(root,{recursive:true,force:true});}
});

test('a second owner on the same data waits for the first instead of sharing it',async()=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'queacp-life-'));const pidFile=path.join(root,'fixture-pids');
  try{
    const first=start(root,pidFile);await first.rpc({action:'health',ids:[]});
    const second=start(root,pidFile);
    const read=second.rpc({action:'health',ids:[]});
    await sleep(300);
    assert.equal(Number(readFileSync(path.join(root,'owner.pid'),'utf8')),first.child.pid,'first owner keeps the data');
    first.child.stdin.end();
    await read;
    assert.equal(Number(readFileSync(path.join(root,'owner.pid'),'utf8')),second.child.pid,'second owner takes over after the first exits');
    second.child.stdin.end();await until(()=>second.child.exitCode!==null);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('a card is one session: never rebound, and an empty one is started fresh instead of restored', async()=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'queacp-life-'));const pidFile=path.join(root,'fixture-pids');
  writeFileSync(path.join(root,'agents.json'),JSON.stringify({fixture:[process.execPath,path.resolve('tests/acp/agent.mjs')],other:[process.execPath,path.resolve('tests/acp/agent.mjs')]}));
  // Like Devin, the fixture cannot load a session that never received a prompt.
  const {child,rpc}=start(root,pidFile,{QUEACP_TEST_EMPTY_ROLLOUT:path.join(root,'rollout'),QUEACP_TEST_LOAD_ERROR:'not-found'});
  try{
    const session=await rpc({action:'ensure',id:'card',cwd:root,agent:'fixture'});
    assert.equal(session.recordId,'card','the card id is the acpx session key');
    await assert.rejects(rpc({action:'ensure',id:'card',cwd:root,agent:'other'}),/已绑定/);
    await rpc({action:'close',id:'card'});
    const sent=await rpc({action:'send',id:'card',requestId:'resume',text:'hh'});
    let turn;for(let i=0;i<200;i++){turn=(await rpc({action:'read',id:'card'})).turns.find(t=>t.id===sent.id);if(['completed','failed'].includes(turn?.state))break;await sleep(40);}
    assert.equal(turn.state,'completed','nothing was said, so nothing is restored: the agent starts fresh');
  }finally{child.stdin.end();await until(()=>child.exitCode!==null);for(const pid of agentPids(pidFile))try{process.kill(pid,'SIGKILL')}catch{};rmSync(root,{recursive:true,force:true});}
});
