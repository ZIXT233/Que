import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import readline from 'node:readline';
const host=process.env.QUE_TEST_SSH;
test('remote owner survives SSH relay disconnect with pending approval', {skip:!host,timeout:30000},async()=>{
 const ssh=(command,input)=>execFileSync('ssh',['-o','BatchMode=yes','-o','ConnectTimeout=8',host,command],{input,encoding:'utf8'});
 const root=ssh('mktemp -d /tmp/que-acp-remote-XXXXXXXX').trim();
 assert.match(root,/^\/tmp\/que-acp-remote-[A-Za-z0-9]+$/);
 let child,serial=0; const pending=new Map();
 const connect=()=>{
  child=spawn('ssh',['-T','-o','BatchMode=yes',host,`QUE_ACP_ROOT='${root}/state' QUE_ACP_STORE_DIR='${root}/acpx' node '${root}/owner.mjs'`]);
  readline.createInterface({input:child.stdout}).on('line',line=>{const v=JSON.parse(line);if(v.rpc){const p=pending.get(v.rpc);pending.delete(v.rpc);v.error?p.reject(Error(v.error)):p.resolve(v.result)}});
 };
 const rpc=body=>new Promise((resolve,reject)=>{const rpc=String(++serial);pending.set(rpc,{resolve,reject});child.stdin.write(JSON.stringify({...body,rpc})+'\n')});
 try{
  ssh(`cat > '${root}/owner.mjs'`,readFileSync('src-tauri/resources/bin/acp-owner.mjs'));
  ssh(`cat > '${root}/agent.mjs'`,readFileSync('tests/acp/agent.mjs'));
  ssh(`mkdir -m 700 '${root}/state'; cat > '${root}/state/agents.json'`,JSON.stringify({fixture:['node',`${root}/agent.mjs`],missing:[`${root}/missing-agent`]}));
  connect();
  await assert.rejects(rpc({action:'ensure',id:'retry-card',agent:'missing',cwd:root}),/spawn/);
  const retried=await rpc({action:'ensure',id:'retry-card',agent:'fixture',cwd:root});
  assert.equal(retried.agent,'fixture');
  await assert.rejects(rpc({action:'ensure',id:'retry-card',agent:'missing',cwd:root}),/已绑定/);
  await rpc({action:'close',id:'retry-card'});
  await assert.rejects(rpc({action:'ensure',id:'retry-card',agent:'missing',cwd:root}),/已绑定/);
  await rpc({action:'ensure',id:'remote-card',agent:'fixture',cwd:root});
  await rpc({action:'send',id:'remote-card',requestId:'first',text:'permission'});
  let decision;
  for(let i=0;i<80&&!decision;i++){const s=await rpc({action:'read',id:'remote-card'});decision=s.turns[0].blocks.find(b=>b.type==='decision');if(!decision)await new Promise(r=>setTimeout(r,50))}
  assert.ok(decision);child.kill();connect();
  const after=await rpc({action:'read',id:'remote-card'});assert.equal(after.turns[0].blocks.find(b=>b.type==='decision').id,decision.id);
  await rpc({action:'answer',id:'remote-card',decisionId:decision.id,answer:{outcome:'reject_once'}});
  let completed=false;
  for(let i=0;i<80&&!completed;i++){completed=(await rpc({action:'read',id:'remote-card'})).turns[0].state==='completed';if(!completed)await new Promise(r=>setTimeout(r,50))}
  assert.equal(completed,true);await rpc({action:'close',id:'remote-card'});
 }finally{
  child?.kill();
  ssh(`if [ -f '${root}/state/owner.pid' ]; then kill "$(cat '${root}/state/owner.pid')"; fi; for i in $(seq 1 240); do [ ! -f '${root}/state/owner.pid' ] && break; sleep 0.05; done; test ! -f '${root}/state/owner.pid' && rm -rf '${root}'`);
 }
});
