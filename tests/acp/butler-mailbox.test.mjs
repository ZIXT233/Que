import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import readline from 'node:readline';
import os from 'node:os';
import path from 'node:path';
const binary=process.env.FLAT_HEADLESS_TEST_BINARY;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

test('Butler gets replies by mail, compact reads, no per-event wakeups, and digests on request', {skip:!binary}, async()=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'flat-mailbox-'));
  const child=spawn(binary,[root],{env:{...process.env,QUE_BIN_DIR:path.resolve('src-tauri/resources/bin'),FLAT_ACP_STORE_DIR:path.join(root,'acpx')},stdio:['pipe','pipe','pipe']});
  try {
    const {base}=await new Promise((resolve,reject)=>{
      readline.createInterface({input:child.stdout}).on('line',line=>{try{const v=JSON.parse(line);if(v.base)resolve(v)}catch{}});
      child.once('exit',code=>reject(Error('headless exited '+code)));child.stderr.on('data',()=>{});
    });
    const data=path.join(root,'que'),home=path.join(root,'home','.flat','butler'),work=path.join(root,'work');
    for(const dir of [home,work,path.join(data,'acp')])mkdirSync(dir,{recursive:true});
    writeFileSync(path.join(data,'acp','agents.json'),JSON.stringify({fixture:[process.execPath,path.resolve('tests/acp/agent.mjs')]}));
    const butler='b071e000-0000-4000-8000-000000000001',target='card-b';
    const card=(id,cwd,workspaceId)=>({id,cwd,workspaceId,phase:'attention',createdAt:0,harness:{kind:'fixture',terminalId:id,state:'not_running'}});
    writeFileSync(path.join(data,'queue.json'),JSON.stringify({version:1,revision:0,order:[butler,target],cards:[card(butler,home,'flat-butler'),{...card(target,work,'w'),nickname:'Packaging foo'}],
      workspaces:[{id:'flat-butler',name:'Butler',kind:'local',cwd:home,runtimeCwd:home},{id:'w',name:'Distro',kind:'local',cwd:work,runtimeCwd:work}]}));
    const request=async(url,body,headers={})=>{
      const r=await fetch(base+url,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...headers},body:body&&JSON.stringify(body),signal:AbortSignal.timeout(20000)});
      const value=await r.json();if(!r.ok)throw Error(JSON.stringify(value));return value;
    };
    const butlerSession=await request('/api/acp/'+butler,{action:'ensure',agent:'fixture',cwd:home});
    await request('/api/acp/'+target,{action:'ensure',agent:'fixture',cwd:work});
    const {token}=JSON.parse(readFileSync(path.join(data,'mcp','endpoint.json'),'utf8'));
    const headers={authorization:'Bearer '+token,'x-que-client-id':'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','x-que-source-terminal':butler,'x-flat-source-epoch':butlerSession.connectionId};
    const tool=async body=>{const r=await request('/api/mcp/tools',body,headers);return r.result ?? r;};
    const events=async()=>(await request('/api/acp/'+butler)).turns.filter(t=>t.source==='event');
    const until=async(predicate,label)=>{for(let i=0;i<400;i++){const v=await predicate();if(v)return v;await sleep(50);}throw Error('timeout: '+label);};

    await tool({tool:'send_message',cardId:target,sessionId:target,requestId:'job-1',text:'rebuild foo'});
    const mail=await until(async()=>(await events()).find(t=>t.text.includes('Que 回信')),'reply delivered');
    assert.match(mail.text,/Packaging foo/);assert.match(mail.text,/任务已处理/);assert.match(mail.text,/rebuild foo/);
    assert.doesNotMatch(mail.text,/检查当前任务/,'thoughts are not mailed');

    const view=await tool({tool:'read_session',cardId:target,sessionId:target});
    assert.equal(view.turns.at(-1).message,'rebuild foo');assert.match(view.turns.at(-1).reply,/任务已处理/);
    assert.ok(JSON.stringify(view).length<4000,'compact read stays small');
    assert.ok(!JSON.stringify(view).includes('example.ts'),'tool output is left out unless asked for');
    const full=await tool({tool:'read_session',cardId:target,sessionId:target,turnId:view.turns.at(-1).turnId});
    assert.ok(JSON.stringify(full).includes('example.ts'),'one turn in full on request');

    // The status watch saw the completion too, but the Butler is not woken for it.
    await sleep(3000);
    assert.equal((await events()).length,1,'only the reply reached the Butler');

    assert.deepEqual(await request('/api/butler/digest',{}),{sent:true});
    const digest=await until(async()=>(await events()).find(t=>t.text.includes('定时汇总请求')),'digest delivered');
    assert.match(digest.text,/「Packaging foo」（Distro）/);assert.match(digest.text,/用户上次说|最后回复/);
    assert.match(digest.text,/自上次汇总：完成 1 轮/);
  } finally {
    child.kill('SIGTERM');
    for(let i=0;i<200&&child.exitCode===null&&child.signalCode===null;i++)await sleep(25);
    // The owner leaves after the app; remove its files only once it is gone.
    const ownerPid=path.join(root,'que','acp','owner.pid');
    for(let i=0;i<400&&existsSync(ownerPid);i++)await sleep(25);
    rmSync(root,{recursive:true,force:true});
  }
});
