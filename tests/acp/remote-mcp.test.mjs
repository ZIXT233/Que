import {test} from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import {remoteMcpHub} from '../../runtime/remote-mcp.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const socketCall=(socketPath,capability,body)=>new Promise((resolve,reject)=>{
 const socket=net.createConnection(socketPath);let data='';
 socket.on('error',reject);socket.on('connect',()=>socket.write(JSON.stringify({capability,body})+'\n'));
 socket.on('data',chunk=>{data+=chunk;if(data.includes('\n')){socket.destroy();resolve(JSON.parse(data.split('\n')[0]))}});
});
test('reverse MCP routes one card, rejects spoofed replies and never replays uncertain calls',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'que-mcp-'));const address=path.join(root,'mcp.sock');
 const sessions={a:{connectionId:'run-a',state:'working'},b:{connectionId:'run-b',state:'attention'}};
 const messages=[],otherMessages=[];
 const client={write:line=>messages.push(JSON.parse(line))},other={write:line=>otherMessages.push(JSON.parse(line))};
 const hub=remoteMcpHub({socketPath:address,sessions:()=>sessions,timeoutMs:300});
 await hub.listen();hub.bind('a',client);hub.bind('b',other);
 const token=hub.capability('a','run-a');
 const waitMessage=async n=>{for(let i=0;messages.length<n&&i<100;i++)await sleep(2);assert.ok(messages.length>=n);return messages[n-1]};
 try{
  const denied=await socketCall(address,'fake',{tool:'list_cards'});assert.equal(denied.isError,true);assert.equal(messages.length,0);
  const first=socketCall(address,token,{tool:'list_cards',cardId:'spoof'});const message=await waitMessage(1);
  assert.equal(message.cardId,'a');assert.equal(message.epoch,'run-a');assert.equal(otherMessages.length,0);
  hub.receive(other,{requestId:message.requestId,result:{isError:false,content:[]}});
  hub.receive(client,{requestId:message.requestId,result:{isError:false,content:[{type:'text',text:'right route'}]}});
  assert.equal((await first).content[0].text,'right route');
  const pending=socketCall(address,token,{tool:'send_message'});await waitMessage(2);hub.unbind(client);
  assert.match((await pending).content[0].text,/interrupted/);
  hub.bind('a',other);await sleep(10);assert.equal(otherMessages.length,0,'reconnect must not resend');
  const next=socketCall(address,token,{tool:'list_cards'});while(!otherMessages.length)await sleep(2);
  hub.receive(other,{requestId:otherMessages[0].requestId,result:{isError:false,content:[]}});assert.equal((await next).isError,false);
  const timed=await socketCall(address,token,{tool:'send_message'});assert.match(timed.content[0].text,/timed out/);
  sessions.a.connectionId='new-run';assert.equal((await socketCall(address,token,{tool:'list_cards'})).isError,true);
  assert.equal(messages.length,2);
 }finally{await hub.close();await rm(root,{recursive:true,force:true});}
});

test('real owner injects remote bridge and relays reverse calls over its stdio stream',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'que-mcp-owner-'));const children=[];let ownerPid;
 await writeFile(path.join(root,'agents.json'),JSON.stringify({fixture:[process.execPath,path.resolve('tests/acp/agent.mjs')]}));
 const env={...process.env,QUE_ACP_ROOT:root,QUE_ACP_STORE_DIR:path.join(root,'acpx'),QUE_TEST_MCP_FILE:path.join(root,'mcp.json')};
 function connect(){
  const child=spawn(process.execPath,['src-tauri/resources/bin/acp-owner.mjs'],{env});children.push(child);
  const pending=new Map(),reverse=[];let count=0,error='';child.stderr.on('data',d=>error+=d);child.stdin.on('error',()=>{});
  readline.createInterface({input:child.stdout}).on('line',line=>{const v=JSON.parse(line);if(v.event==='mcp_request')reverse.push(v);const p=pending.get(v.rpc);if(p){pending.delete(v.rpc);v.error?p.reject(Error(v.error)):p.resolve(v.result)}});
  child.on('exit',()=>{for(const p of pending.values())p.reject(Error(error||'relay exited'));pending.clear()});
  return {child,reverse,rpc:body=>new Promise((resolve,reject)=>{const rpc=String(++count);pending.set(rpc,{resolve,reject});child.stdin.write(JSON.stringify({...body,rpc})+'\n')}),reply:v=>child.stdin.write(JSON.stringify({action:'_mcp_result',...v})+'\n')};
 }
 function bridge(config){
  const child=spawn(config.command,config.args,{env:{...process.env,...Object.fromEntries(config.env.map(e=>[e.name,e.value]))}});children.push(child);
  let count=0;const pending=new Map();
  readline.createInterface({input:child.stdout}).on('line',line=>{const v=JSON.parse(line);pending.get(v.id)?.(v.result);pending.delete(v.id)});
  return body=>new Promise(resolve=>{const id=++count;pending.set(id,resolve);child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method:'tools/call',params:body})+'\n')});
 }
 const waitReverse=async relay=>{for(let i=0;i<200&&!relay.reverse.length;i++)await sleep(5);assert.ok(relay.reverse.length);return relay.reverse.shift()};
 try{
  const a=connect();const session=await a.rpc({action:'ensure',id:'remote-card',agent:'fixture',cwd:root,mcpRelay:true});
  ownerPid=Number(await readFile(path.join(root,'owner.pid'),'utf8'));
  const config=JSON.parse(await readFile(path.join(root,'mcp.json'),'utf8'))[0];assert.equal(config.name,'que');
  assert.ok(config.env.some(e=>e.name==='QUE_MCP_SOCKET'));assert.ok(!config.env.some(e=>e.name==='QUE_MCP_ENDPOINT_FILE'));
  const token=config.env.find(e=>e.name==='QUE_MCP_CAPABILITY').value;assert.ok(!JSON.stringify(session).includes(token));
  const call=bridge(config);const result=call({name:'list_cards',arguments:{}});const request=await waitReverse(a);
  assert.equal(request.cardId,'remote-card');assert.equal(request.epoch,session.connectionId);
  assert.equal((await a.rpc({action:'read',id:'remote-card'})).connectionId,session.connectionId,'normal ACP replies continue while a reverse call waits');
  a.reply({requestId:request.requestId,result:{content:[{type:'text',text:'fixture cards'}],isError:false}});
  assert.equal((await result).content[0].text,'fixture cards');
  const uncertain=call({name:'send_message',arguments:{cardId:'target',sessionId:'target',text:'fixture only',requestId:'once'}});
  // The app going away ends the owner; an in-flight call reports an unknown result, never a retry.
  await waitReverse(a);a.child.stdin.end();assert.equal((await uncertain).isError,true);
  for(let i=0;i<300&&a.child.exitCode===null;i++)await sleep(20);
  assert.equal(a.child.exitCode,0);
 }finally{
  for(const child of children)child.kill();if(ownerPid)try{process.kill(ownerPid)}catch{}
  for(let i=0;i<220&&existsSync(path.join(root,'owner.pid'));i++)await sleep(50);
  await rm(root,{recursive:true,force:true});
 }
});
