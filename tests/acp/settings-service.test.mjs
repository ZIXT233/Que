import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,readFile,mkdir,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
const binary=process.env.QUE_SETTINGS_TEST_BINARY;
test('settings MCP uses real API, validates scopes, redacts secrets and creates workspaces idempotently',{skip:!binary},async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'que-settings-api-'));
 const child=spawn(binary,[root],{env:{...process.env,QUE_BIN_DIR:path.resolve('src-tauri/resources/bin')},stdio:['pipe','pipe','pipe']});let stderr='';child.stderr.on('data',d=>stderr+=d);
 const lines=readline.createInterface({input:child.stdout});
 const controls=new Map();
 const address=new Promise((resolve,reject)=>{lines.on('line',line=>{try{const v=JSON.parse(line);if(v.base)resolve(v);if(v.controlId)controls.get(v.controlId)?.(v)}catch{}});child.once('exit',()=>reject(Error(stderr)))});
 // The main window's native commands, which no Agent can call.
 let control=0;
 const native=(method,args={})=>new Promise((resolve,reject)=>{const id=String(++control);
  controls.set(id,v=>v.error?reject(Error(v.error)):resolve(v.result));child.stdin.write(JSON.stringify({controlId:id,method,...args})+'\n');});
 let card,ownerPid;
 try{
  const {base,token:apiToken}=await address;
  // Loopback is reachable by any process and, through the browser, any page: the API answers only Que's own windows.
  assert.equal((await fetch(base+'/api/card-queue')).status,401,'no token, no API');
  assert.equal((await fetch(base+'/api/card-queue',{headers:{'x-que-token':'guess'}})).status,401,'a wrong token is refused');
  assert.equal((await fetch(base+'/api/card-queue?token='+apiToken)).status,200,'the token works in the query, for EventSource');
  assert.notEqual((await fetch(base+'/api/mcp/tools',{method:'POST',body:'{}'})).status,200,'MCP keeps its own token');
  const request=async(route,body,headers={})=>{const r=await fetch(base+route,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','x-que-token':apiToken,...headers},body:body?JSON.stringify(body):undefined});const data=await r.json();if(!r.ok)throw Error(data.error||JSON.stringify(data));return data;};
  const acpRoot=path.join(root,'que','acp');await mkdir(acpRoot,{recursive:true});await writeFile(path.join(acpRoot,'agents.json'),JSON.stringify({codex:[process.execPath,path.resolve('tests/acp/agent.mjs')]}));
  const home=path.join(root,'home');await mkdir(home,{recursive:true});
  const workspaceId=(await request('/api/card-queue',{action:'workspace_create',kind:'local',cwd:home,name:'Home'})).workspaces.find(w=>w.name==='Home').id;
  // A card is made with its agent.
  card=(await request('/api/card-queue',{action:'create',workspaceId,kind:'codex'})).createdId;
  await request('/api/card-queue',{action:'harness_resume',id:card});
  assert.ok((await request('/api/card-queue')).cards.every(c=>c.harness),'no card is ever blank');
  const session=await request('/api/acp/'+card);ownerPid=Number(await readFile(path.join(acpRoot,'owner.pid'),'utf8'));
  const discovery=JSON.parse(await readFile(path.join(root,'que','mcp','endpoint.json'),'utf8'));
  const headers={Authorization:'Bearer '+discovery.token,'X-Que-Client-Id':crypto.randomUUID(),'X-Que-Source-Terminal':card,'X-Que-Source-Epoch':session.connectionId};
  const call=(tool,args={})=>request('/api/mcp/tools',{tool,...args},headers);
  const denied={...headers};delete denied['X-Que-Source-Terminal'];delete denied['X-Que-Source-Epoch'];
  await assert.rejects(request('/api/mcp/tools',{tool:'update_settings',scope:'ui',patch:{theme:'dark'}},denied),/may not/);
  await assert.rejects(call('update_settings',{scope:'ui',patch:{theme:'dark'}}),/may not read or change settings/,'settings need the permission');
  await native('card_permissions_set',{id:card,permissions:{settings:true}});
  assert.ok((await call('list_settings')).ui.theme);
  await call('update_settings',{scope:'ui',patch:{theme:'dark',fontSize:18}});
  assert.equal((await request('/api/preferences')).theme,'dark');
  await assert.rejects(call('update_settings',{scope:'ui',patch:{theme:'light',fontSize:99}}),/Invalid/);
  assert.equal((await request('/api/preferences')).theme,'dark');
  await assert.rejects(call('update_settings',{scope:'ui',patch:{theme:'light'},expected:{theme:'auto'}}),/changed/);
  await call('update_settings',{scope:'speech',patch:{apiKey:'fixture-secret',language:'zh'}});
  await call('update_settings',{scope:'speech',patch:{language:'en'}});
  const speech=await call('read_settings',{scope:'speech'});assert.equal(speech.configured,true);assert.equal(speech.language,'en');assert.doesNotMatch(JSON.stringify(speech),/fixture-secret/);
  await call('update_settings',{scope:'machine',target:'local',patch:{terminalRc:'export TEST=value',sessionEnv:{TEST_SECRET:'secret-value'}}});
  const machine=await call('read_settings',{scope:'machine',target:'local'});assert.deepEqual(machine.environmentKeys,['TEST_SECRET']);assert.doesNotMatch(JSON.stringify(machine),/secret-value|export TEST/);
  const workspace=await call('create_workspace',{name:'Test workspace',kind:'local',cwd:root});
  await call('update_settings',{scope:'workspace',target:workspace.workspaceId,patch:{defaultConversationWeight:8}});
  const duplicate=await call('create_workspace',{name:'Retry',kind:'local',cwd:root});assert.equal(duplicate.workspaceId,workspace.workspaceId);assert.equal(duplicate.alreadyExists,true);
  const settings=await call('read_settings',{scope:'workspace',target:workspace.workspaceId});assert.equal(settings.name,'Test workspace');assert.equal(settings.defaultConversationWeight,8);
  await assert.rejects(call('create_workspace',{name:'Missing',kind:'local',cwd:path.join(root,'missing')}));
  await call('update_settings',{scope:'queue',patch:{sortMode:'fifo',insertionPosition:'top'}});
  await assert.rejects(call('update_settings',{scope:'queue',patch:{sortMode:'score',insertionPosition:'invalid'}}));
  assert.equal((await call('read_settings',{scope:'queue'})).sortMode,'fifo');
  const host={hostname:'example.invalid',name:'Fixture',user:'test',port:22};
  const first=await call('configure_remote_host',{operation:'save',host});const again=await call('configure_remote_host',{operation:'save',host});assert.equal(first.host.id,again.host.id);
  await call('configure_remote_host',{operation:'save',host:{...host,id:first.host.id,name:'Renamed'}});
  assert.equal((await call('list_remote_hosts')).hosts.find(h=>h.id===first.host.id).name,'Renamed');
  await mkdir(path.join(root,'home','.ssh'),{recursive:true});await writeFile(path.join(root,'home','.ssh','config'),'Host fixture-config\n  HostName fixture.invalid\n');
  await call('configure_remote_host',{operation:'set-visibility',hostId:'fixture-config',visible:false});
  assert.equal((await call('list_remote_hosts')).hosts.find(h=>h.id==='fixture-config').visible,false);
  await call('update_settings',{scope:'app',patch:{debugLogging:true}});assert.equal((await call('read_settings',{scope:'app'})).debugLogging,true);
 }finally{
  child.stdin.end();await new Promise(resolve=>{if(child.exitCode!==null)return resolve();child.once('exit',resolve);setTimeout(()=>child.kill(),3000).unref()});
  if(ownerPid)try{process.kill(ownerPid)}catch{}
  for(let i=0;i<120&&existsSync(path.join(root,'que','acp','owner.pid'));i++)await new Promise(r=>setTimeout(r,50));
  await rm(root,{recursive:true,force:true});
 }
});
