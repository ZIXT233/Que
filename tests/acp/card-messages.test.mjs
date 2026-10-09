import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import readline from 'node:readline';
import os from 'node:os';
import path from 'node:path';
const binary=process.env.QUEACP_HEADLESS_TEST_BINARY;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

test('cards message each other through inboxes: idle, busy, waiting, after the turn; guarded; digested', {skip:!binary, timeout:120000}, async()=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'queacp-messages-'));
  const child=spawn(binary,[root],{env:{...process.env,QUE_BIN_DIR:path.resolve('src-tauri/resources/bin'),QUEACP_ACP_STORE_DIR:path.join(root,'acpx')},stdio:['pipe','pipe','pipe']});
  try {
    const {base}=await new Promise((resolve,reject)=>{
      readline.createInterface({input:child.stdout}).on('line',line=>{try{const v=JSON.parse(line);if(v.base)resolve(v)}catch{}});
      child.once('exit',code=>reject(Error('headless exited '+code)));child.stderr.on('data',()=>{});
    });
    const data=path.join(root,'que'),home=path.join(root,'home','.queacp','butler'),work=path.join(root,'work');
    for(const dir of [home,work,path.join(data,'acp')])mkdirSync(dir,{recursive:true});
    writeFileSync(path.join(data,'acp','agents.json'),JSON.stringify({fixture:[process.execPath,path.resolve('tests/acp/agent.mjs')]}));
    const butler='b071e000-0000-4000-8000-000000000001',shen='5be00000-0000-4000-8000-000000000001',yang='7a000000-0000-4000-8000-000000000001';
    const card=(id,cwd,workspaceId,nickname)=>({id,cwd,workspaceId,nickname,phase:'attention',createdAt:0,harness:{kind:'fixture',terminalId:id,state:'not_running'}});
    writeFileSync(path.join(data,'queue.json'),JSON.stringify({version:1,revision:0,order:[butler,shen,yang],
      cards:[card(butler,home,'queacp-butler'),card(shen,work,'w','沈一石'),card(yang,work,'w','杨金水')],
      workspaces:[{id:'queacp-butler',name:'Butler',kind:'local',cwd:home,runtimeCwd:home},{id:'w',name:'Distro',kind:'local',cwd:work,runtimeCwd:work}]}));
    const request=async(url,body,headers={})=>{
      const r=await fetch(base+url,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...headers},body:body&&JSON.stringify(body),signal:AbortSignal.timeout(30000)});
      const value=await r.json();if(!r.ok)throw Error(JSON.stringify(value));return value;
    };
    const sessions={};
    for(const [id,cwd] of [[butler,home],[shen,work],[yang,work]]) sessions[id]=await request('/api/acp/'+id,{action:'ensure',agent:'fixture',cwd});
    const {token}=JSON.parse(readFileSync(path.join(data,'mcp','endpoint.json'),'utf8'));
    const as=id=>({authorization:'Bearer '+token,'x-que-client-id':'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','x-que-source-terminal':id,'x-queacp-source-epoch':sessions[id].connectionId});
    const tool=(from,body)=>request('/api/mcp/tools',body,as(from));
    const send=(from,to,requestId,text)=>tool(from,{tool:'send_message',cardId:to,sessionId:to,requestId,text});
    const turns=async id=>(await request('/api/acp/'+id)).turns;
    const until=async(predicate,label)=>{for(let i=0;i<400;i++){const v=await predicate();if(v)return v;await sleep(50);}throw Error('timeout: '+label);};
    const settled=id=>until(async()=>(await turns(id)).every(t=>['completed','failed','cancelled'].includes(t.state)),'settled');
    // A turn that waits on the user's decision keeps a card busy.
    const busy=async(id,requestId)=>{
      await request('/api/acp/'+id,{action:'send',requestId,text:'permission please'});
      return until(async()=>(await turns(id)).find(t=>t.id===requestId||t.text==='permission please'&&t.state==='running')?.blocks?.find(b=>b.type==='decision'&&b.state==='pending'),'decision pending');
    };
    const release=(id,decision)=>request('/api/acp/'+id,{action:'answer',decisionId:decision.id,answer:{outcome:'allow_once'}});

    // 1. Idle: the message is the target's next turn, signed by the sender.
    const sent=await send(shen,yang,'ask','你那边构建好了吗？');
    assert.equal(sent.delivery,'inbox');
    const asked=await until(async()=>(await turns(yang)).find(t=>t.sender),'delivered as a turn');
    assert.equal(asked.source,'agent');assert.equal(asked.sender.name,'沈一石');assert.equal(asked.text,'你那边构建好了吗？','the header is not part of what is shown');
    await settled(yang);
    await sleep(1500);
    assert.equal((await turns(shen)).length,0,'nothing is relayed back by itself');

    // 2. Busy: the answer rides on the sender's next QueACP tool result, once.
    const decision=await busy(shen,'work-1');
    await send(yang,shen,'answer-1','构建好了，版本 1.2');
    await sleep(1500);
    assert.equal((await turns(shen)).length,1,'a busy card is not given a second turn');
    const listed=await tool(shen,{tool:'list_cards'});
    assert.equal(listed.queacpMessages.length,1);
    assert.equal(listed.queacpMessages[0].from.name,'杨金水');assert.equal(listed.queacpMessages[0].text,'构建好了，版本 1.2');
    assert.equal((await tool(shen,{tool:'list_cards'})).queacpMessages,undefined,'handed over exactly once');

    // 3. Waiting: wait_messages returns as soon as the answer arrives.
    const waiting=tool(shen,{tool:'wait_messages',timeoutSeconds:20});
    await sleep(300);
    await send(yang,shen,'answer-2','测试也过了');
    const waited=await waiting;
    assert.deepEqual(waited.queacpMessages.map(m=>m.text),['测试也过了']);
    assert.deepEqual((await tool(shen,{tool:'wait_messages',timeoutSeconds:1})).queacpMessages,[],'an empty wait ends on time');

    // 4. Not picked up while busy: it becomes a turn once the current one ends.
    await send(yang,shen,'answer-3','我先下班了');
    await release(shen,decision);
    const later=await until(async()=>(await turns(shen)).find(t=>t.sender?.name==='杨金水'),'delivered after the turn');
    assert.equal(later.text,'我先下班了');
    await settled(shen);
    assert.equal((await turns(shen)).filter(t=>t.sender).length,1,'each message is handed over once');

    // Loop guard: a repeat is refused, a retry of the same request is not.
    await assert.rejects(send(yang,shen,'answer-4','我先下班了'),/same message/);
    assert.equal((await send(yang,shen,'answer-3','我先下班了')).delivery,'inbox');
    await sleep(1500);
    assert.equal((await turns(shen)).filter(t=>t.sender).length,1,'the retried request posts nothing new');
    await assert.rejects(send(shen,shen,'self','hi'),/itself/);

    // Managing cards is the Butler's.
    await assert.rejects(tool(shen,{tool:'archive_card',cardId:yang,requestId:'x'}),/Butler/);

    // The digest reports what ended since the last one, without watching cards.
    assert.deepEqual(await request('/api/butler/digest',{}),{sent:true});
    const digest=await until(async()=>(await turns(butler)).find(t=>t.text.includes('定时汇总请求')),'digest delivered');
    assert.match(digest.text,/「杨金水」（Distro）/);assert.match(digest.text,/自上次汇总：完成 1 轮/);
  } finally {
    child.kill('SIGTERM');
    for(let i=0;i<200&&child.exitCode===null&&child.signalCode===null;i++)await sleep(25);
    // The owner leaves after the app; remove its files only once it is gone.
    const ownerPid=path.join(root,'que','acp','owner.pid');
    for(let i=0;i<400&&existsSync(ownerPid);i++)await sleep(25);
    rmSync(root,{recursive:true,force:true});
  }
});
