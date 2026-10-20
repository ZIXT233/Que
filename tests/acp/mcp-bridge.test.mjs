import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

test('MCP bridge sends ACP card UUID and source run identity without rewriting message',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'que-peer-'));
 const card='01234567-0123-4123-8123-0123456789ab',epoch='run-one';
 let received;
 const server=http.createServer((req,res)=>{let data='';req.on('data',d=>data+=d);req.on('end',()=>{received={headers:req.headers,body:JSON.parse(data)};res.setHeader('Content-Type','application/json');res.end(JSON.stringify({state:'queued',id:'request-one'}));});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 let child;
 try {
  const config=path.join(root,'endpoint.json');
  await writeFile(config,JSON.stringify({url:`http://127.0.0.1:${server.address().port}/api/mcp/tools`,token:'a'.repeat(32)}));
  child=spawn(process.execPath,['scripts/que-mcp.cjs'],{env:{...process.env,QUE_SOURCE_CARD:card,QUE_SOURCE_EPOCH:epoch,QUE_MCP_ENDPOINT_FILE:config}});
  const response=new Promise((resolve,reject)=>{readline.createInterface({input:child.stdout}).on('line',line=>resolve(JSON.parse(line)));child.on('error',reject);child.once('exit',code=>reject(new Error(`MCP bridge exited before responding: ${code}`)));});
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'send_message',arguments:{cardId:'target',sessionId:'target',requestId:'request-one',text:'Hello B'}}})+'\n');
  assert.equal((await response).result.isError,false);
  assert.equal(received.headers['x-que-source-terminal'],card);
  assert.equal(received.headers['x-que-source-epoch'],epoch);
  assert.equal(received.body.text,'Hello B');assert.equal(received.body.tool,'send_message');
 }finally{child?.kill();await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});}
});

test('card lifecycle tools expose workspace and Harness selection',async()=>{
 const child=spawn(process.execPath,['scripts/que-mcp.cjs']);
 try {
  const response=new Promise((resolve,reject)=>{readline.createInterface({input:child.stdout}).once('line',line=>resolve(JSON.parse(line)));child.on('error',reject);child.once('exit',code=>reject(new Error(`MCP bridge exited before tool discovery: ${code}`)));});
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})+'\n');
  const tools=(await response).result.tools;
  const create=tools.find(t=>t.name==='create_card');
  assert.deepEqual(create.inputSchema.required,['workspaceId','kind','requestId']);
  assert.ok(tools.find(t=>t.name==='archive_card'));
  for(const name of ['list_settings','read_settings','list_remote_hosts'])assert.equal(tools.find(t=>t.name===name).annotations.readOnlyHint,true);
  assert.deepEqual(tools.find(t=>t.name==='update_settings').inputSchema.required,['scope','patch']);
  assert.ok(tools.find(t=>t.name==='create_workspace'));assert.ok(tools.find(t=>t.name==='configure_remote_host'));
  assert.equal(tools.find(t=>t.name==='list_workspaces').annotations.readOnlyHint,true);
  assert.equal(tools.find(t=>t.name==='list_harnesses').annotations.readOnlyHint,true);
 }finally{child.kill();}
});
