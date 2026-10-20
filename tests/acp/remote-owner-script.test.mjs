import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,copyFileSync,chmodSync,rmSync,existsSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(predicate,ms=15000){for(let i=0;i<ms/50;i++){if(await predicate())return true;await sleep(50);}return predicate();}

// The script Que runs over SSH, run here by sh with a stand-in tmux that only
// keeps the command alive in the background (what matters to the owner).
function host({tmux=true}={}){
  const root=mkdtempSync(path.join(os.tmpdir(),'que-host-'));
  const home=path.join(root,'home'),bin=path.join(root,'bin'),runtime=path.join(home,'.que','runtime');
  for(const dir of [bin,runtime,path.join(root,'acp')])mkdirSync(dir,{recursive:true});
  const bundle=path.join(runtime,'build.mjs');copyFileSync('src-tauri/resources/bin/acp-owner.mjs',bundle);
  writeFileSync(path.join(root,'acp','agents.json'),JSON.stringify({fixture:[process.execPath,path.resolve('tests/acp/agent.mjs')]}));
  for(const tool of ['node','sh','cat','sleep','printf','nohup','kill'])try{const found=process.env.PATH.split(':').map(d=>path.join(d,tool)).find(existsSync);if(found)writeFileSync(path.join(bin,tool),`#!/bin/sh\nexec ${found} "$@"\n`,{mode:0o755})}catch{}
  if(tmux)writeFileSync(path.join(bin,'tmux'),`#!/bin/sh
case "$1" in
  has-session) [ -f "${root}/tmux.pid" ] && kill -0 "$(cat "${root}/tmux.pid")" 2>/dev/null ;;
  new-session) nohup sh -c "$5" </dev/null >>"${root}/tmux.log" 2>&1 & echo $! > "${root}/tmux.pid" ;;
esac
`,{mode:0o755});
  const env={HOME:home,PATH:bin,QUE_ACP_ROOT:path.join(root,'acp'),QUE_ACP_STORE_DIR:path.join(root,'acpx')};
  const script=readFileSync('resources/remote-owner.sh','utf8').replace('@BUNDLE@',bundle);
  const connect=()=>{
    const child=spawn('/bin/sh',['-c',script],{env,stdio:['pipe','pipe','pipe']});
    const pending=new Map();let serial=0;child.stdin.on('error',()=>{});
    readline.createInterface({input:child.stdout}).on('line',line=>{const v=JSON.parse(line),p=pending.get(v.rpc);if(p){pending.delete(v.rpc);v.error?p.reject(Error(v.error)):p.resolve(v.result)}});
    const exited=new Promise(resolve=>child.on('exit',code=>{for(const p of pending.values())p.reject(Error('connection ended'));resolve(code)}));
    return {child,exited,rpc:body=>new Promise((resolve,reject)=>{const id=String(++serial);pending.set(id,{resolve,reject});child.stdin.write(JSON.stringify({...body,rpc:id})+'\n')})};
  };
  const cleanup=async()=>{const pid=path.join(root,'acp','owner.pid');if(existsSync(pid))try{process.kill(Number(readFileSync(pid,'utf8')))}catch{};await until(()=>!existsSync(pid));rmSync(root,{recursive:true,force:true});};
  return {root,connect,cleanup};
}

test('over SSH, Que starts the owner in tmux once and reconnects to it afterwards', async()=>{
  const h=host();
  try{
    let que=h.connect();
    await que.rpc({action:'ensure',id:'card',cwd:h.root,agent:'fixture'});
    await que.rpc({action:'send',id:'card',requestId:'hold',text:'permission'});
    await until(async()=>(await que.rpc({action:'read',id:'card'})).turns.at(-1)?.blocks.some(b=>b.type==='decision'));
    const owner=Number(readFileSync(path.join(h.root,'acp','owner.pid'),'utf8'));
    que.child.kill();await que.exited;
    que=h.connect();
    const after=await que.rpc({action:'read',id:'card'});
    assert.ok(after.turns.at(-1).blocks.some(b=>b.type==='decision'&&b.state==='pending'),'the remote turn is still waiting');
    assert.equal(Number(readFileSync(path.join(h.root,'acp','owner.pid'),'utf8')),owner,'the same tmux owner, not a new one');
    assert.match(readFileSync(path.join(h.root,'home','.que','runtime','serve.sh'),'utf8'),/export QUE_ACP_ROOT=/,'the owner starts with this login\'s environment');
    que.child.kill();await que.exited;
  }finally{await h.cleanup();}
});

test('without tmux the owner lives only as long as the connection', async()=>{
  const h=host({tmux:false});
  try{
    const que=h.connect();
    await que.rpc({action:'ensure',id:'card',cwd:h.root,agent:'fixture'});
    assert.ok(existsSync(path.join(h.root,'acp','owner.pid')));
    que.child.stdin.end();
    assert.equal(await que.exited,0);
    assert.ok(await until(()=>!existsSync(path.join(h.root,'acp','owner.pid'))),'no keepalive without tmux');
  }finally{await h.cleanup();}
});
