import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import readline from 'node:readline';
import os from 'node:os';
import path from 'node:path';
const binary=process.env.FLAT_HEADLESS_TEST_BINARY;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
async function until(predicate,ms=10000){for(let i=0;i<ms/25;i++){if(predicate())return true;await sleep(25);}return predicate();}

// The real app (Rust) owns the owner, which owns the agents. Killing the app
// outright — no shutdown hook runs — must still leave nothing behind.
for(const signal of ['SIGTERM','SIGKILL'])
test(`app ${signal}: owner and agents do not outlive the app`, {skip:!binary}, async()=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'flat-app-life-'));const pidFile=path.join(root,'fixture-pids');
  const child=spawn(binary,[root],{env:{...process.env,QUE_BIN_DIR:path.resolve('src-tauri/resources/bin'),FLAT_ACP_STORE_DIR:path.join(root,'acpx'),FLAT_TEST_PID_FILE:pidFile,FLAT_TEST_IGNORE_EOF:'1'},stdio:['pipe','pipe','pipe']});
  let ownerPid,agentPid;
  try {
    const {base}=await new Promise((resolve,reject)=>{
      readline.createInterface({input:child.stdout}).on('line',line=>{try{const v=JSON.parse(line);if(v.base)resolve(v)}catch{}});
      child.once('exit',code=>reject(Error('headless exited '+code)));child.stderr.on('data',()=>{});
    });
    const data=path.join(root,'que'),cwd=path.join(root,'work');mkdirSync(cwd,{recursive:true});mkdirSync(path.join(data,'acp'),{recursive:true});
    writeFileSync(path.join(data,'acp','agents.json'),JSON.stringify({fixture:[process.execPath,path.resolve('tests/acp/agent.mjs')]}));
    writeFileSync(path.join(data,'queue.json'),JSON.stringify({version:1,revision:0,order:['card'],cards:[{id:'card',cwd,workspaceId:'w',phase:'attention',createdAt:0,harness:{kind:'fixture',terminalId:'card',state:'not_running'}}],workspaces:[{id:'w',name:'W',kind:'local',cwd,runtimeCwd:cwd}]}));
    const r=await fetch(base+'/api/acp/card',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'ensure',agent:'fixture',cwd}),signal:AbortSignal.timeout(20000)});
    assert.ok(r.ok,await r.text());
    ownerPid=Number(readFileSync(path.join(data,'acp','owner.pid'),'utf8'));
    agentPid=Number(readFileSync(pidFile,'utf8').trim().split('\n')[0]);
    assert.ok(alive(ownerPid)&&alive(agentPid));
    child.kill(signal);
    assert.ok(await until(()=>!alive(ownerPid)),'owner exits with the app');
    assert.ok(await until(()=>!alive(agentPid)),'agent exits with the app');
    assert.equal(existsSync(path.join(data,'acp','owner.pid')),false,'owner shut down gracefully');
  } finally {
    child.kill('SIGKILL');
    for(const pid of [ownerPid,agentPid])if(pid)try{process.kill(pid,'SIGKILL')}catch{}
    rmSync(root,{recursive:true,force:true});
  }
});
