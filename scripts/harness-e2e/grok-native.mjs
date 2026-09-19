// Installed Grok -> production native launcher -> real Que notices/card state.
// Local model fixture, isolated profile, no GUI or account/model charges.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import assert from 'node:assert/strict';
const [exe, grok] = process.argv.slice(2);
assert(exe && grok, 'Usage: grok-native.mjs QUE_HEADLESS_EXE GROK_EXE');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'que grok native 中文-'));
const reports = [], requests = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const model = http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  if (req.url.includes('/models')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({object:'list',data:[{id:'que-test',object:'model',owned_by:'local'},{id:'grok-4.6',object:'model',owned_by:'local'}]})); return; }
  if (!req.url.includes('/responses') && !req.url.includes('/chat/completions')) { res.writeHead(404); res.end('{}'); return; }
  requests.push({ at: Date.now(), url: req.url, body: JSON.parse(raw) });
  // Leave enough time for the real queue watcher to expose Working before Stop.
  await sleep(900);
  res.setHeader('content-type', 'text/event-stream');
  if (req.url.includes('/responses')) {
    const response = { id:'resp_test', object:'response', status:'completed', output:[{id:'msg_test',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'QUE_E2E_OK',annotations:[]}]}],usage:{input_tokens:10,output_tokens:4,total_tokens:14,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}} };
    res.end(`event: response.completed\ndata: ${JSON.stringify({type:'response.completed',response})}\n\n`);
  } else {
    for (const [delta, finish_reason] of [[{role:'assistant',content:'QUE_E2E_OK'},null],[{},'stop']]) res.write(`data: ${JSON.stringify({id:'chatcmpl_test',object:'chat.completion.chunk',created:1,model:'que-test',choices:[{index:0,delta,finish_reason}]})}\n\n`);
    res.end('data: [DONE]\n\n');
  }
});
model.listen(0, '127.0.0.1'); await once(model, 'listening');
const baseModel = `http://127.0.0.1:${model.address().port}`;
let backend, backendExit, stderr = '';
try {
  const env = {...process.env, PATH:path.dirname(grok)+path.delimiter+process.env.PATH, QUE_BIN_DIR:path.resolve('src-tauri/resources/bin'), GROK_DEFAULT_MODEL:'que-test', XAI_API_KEY:'local-fixture', GROK_XAI_API_BASE_URL:baseModel+'/v1', GROK_MODELS_LIST_URL:baseModel+'/v1/models', GROK_CLI_CHAT_PROXY_BASE_URL:baseModel+'/v1', GROK_DISABLE_AUTOUPDATER:'1', GROK_MEMORY:'0', GROK_WORKFLOWS:'0'};
  for (const key of ['QUE_GROK_HOOK_URL','QUE_HARNESS_KIND','QUE_HARNESS_CHANNEL','QUE_HARNESS_SIGNAL_DIR','QUE_EXTERNAL_SIGNAL_DIR']) delete env[key];
  backend = spawn(exe, [path.join(root,'profile')], {env,windowsHide:true,stdio:['pipe','pipe','pipe']});
  backendExit = once(backend,'exit'); backend.stderr.on('data', d=>stderr+=d);
  const ready = await new Promise((resolve,reject)=>{
    let buffer='';const timer=setTimeout(()=>reject(Error('Backend startup timed out: '+stderr)),30000);
    backend.once('error',e=>{clearTimeout(timer);reject(e);}); backend.once('exit',code=>{clearTimeout(timer);reject(Error(`Backend exited ${code}: ${stderr}`));});
    backend.stdout.on('data',d=>{buffer+=d;for(const line of buffer.split('\n'))try{const obj=JSON.parse(line);if(obj.base){clearTimeout(timer);resolve(obj);return;}}catch{}});
  });
  const api = async (route, body, method=body?'POST':'GET') => {
    const response=await fetch(ready.base+route,{method,headers:{'content-type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});
    assert(response.ok,await response.clone().text());return response.json();
  };
  const grokHome=path.join(ready.home,'.grok');await fs.mkdir(grokHome,{recursive:true});
  await fs.writeFile(path.join(grokHome,'config.toml'),`[cli]\nuse_leader = false\n[compat.claude]\nhooks = true\n[compat.cursor]\nhooks = true\n[models]\ndefault = "que-test"\n[model.que-test]\nmodel = "que-test"\nbase_url = "${baseModel}/v1"\napi_key = "local-fixture"\nname = "Local fixture"\n`);
  for (const name of ['.claude','.cursor']) await fs.mkdir(path.join(ready.home,name),{recursive:true});
  await api('/api/tools/settings',{externalNotices:true},'PUT');
  const configPath=path.join(grokHome,'hooks/que-session-state.json');
  const installed=JSON.parse(await fs.readFile(configPath,'utf8'));
  const handlers=Object.values(installed.hooks).flatMap(groups=>groups.flatMap(g=>g.hooks));
  assert.equal(handlers.length,9);assert(handlers.every(h=>h.type==='command'&&h.command==='que-session-state.exe'&&h.timeout===2));
  const cliEnv={...env,HOME:ready.home,USERPROFILE:ready.home,GROK_HOME:grokHome,CLAUDE_CONFIG_DIR:path.join(ready.home,'.claude')};
  const run = async (name, extraEnv={}) => {
    const start=Date.now(), log=path.join(root,`${name}.log`);
    const child=spawn(grok,['--cwd',root,'--debug-file',log,'--model','que-test','--max-turns','1','--tools','','-p','Reply QUE_E2E_OK only.'],{env:{...cliEnv,...extraEnv},cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);
    const timer=setTimeout(()=>child.kill(),30000);
    const [code]=await once(child,'exit');clearTimeout(timer);
    const report={name,code,ms:Date.now()-start,stdout,stderr};reports.push(report);
    assert.equal(code,0,JSON.stringify(report));assert(stdout.includes('QUE_E2E_OK'),JSON.stringify(report));
    assert(!/hook[^\n]*(?:failed|timed out|exit(?:ed)? with code [1-9])/i.test(stdout+stderr),JSON.stringify(report));
    const trace=await fs.readFile(log,'utf8');
    const timings=[...trace.matchAll(/(?:hook|stop hook) completed hook_name=global\/que-session-state[^\n]*elapsed_ms=(\d+)/g)].map(m=>Number(m[1]));
    report.hookElapsedMs=timings;
    report.allHookRuns=[...trace.matchAll(/(?:hook|stop hook) completed hook_name=(\S+) elapsed_ms=(\d+)/g)].map(m=>({hook:m[1],ms:Number(m[2])}));
    assert(timings.length>=3,'Missing actual Grok hook execution timings: '+log);
    assert(timings[0]<2000 && timings.slice(1).every(ms=>ms<1000),'Grok hook exceeded cold-start/turn budget: '+JSON.stringify(timings));
    await sleep(650);
    return (await api('/api/card-queue')).external.filter(n=>n.kind==='grok');
  };
  let notices=await run('external');
  assert(reports[0].allHookRuns.some(r=>r.hook.startsWith('global/settings:')),'Claude compatibility registration was not actually exercised');assert.equal(notices.length,1,JSON.stringify(notices));assert.equal(notices[0].state,'attention');
  if (!notices[0].preview) {
    const capture=path.join(root,'capture');await fs.mkdir(capture);
    await run('capture',{QUE_EXTERNAL_SIGNAL_DIR:capture});
    reports.push({envelopes:await Promise.all((await fs.readdir(capture)).filter(f=>f.endsWith('.json')).map(async f=>JSON.parse(await fs.readFile(path.join(capture,f),'utf8'))))});
  }
  assert(notices[0].preview?.includes('QUE_E2E_OK'),JSON.stringify(notices));
  // Same installed CLI now exercised through Que's normal card/PTY launch path.
  const manifest={cases:[{name:'Grok native internal two turns',kind:'grok',mode:'internal',hookCounts:{SessionStart:1,UserPromptSubmit:2,Stop:2},steps:[
    {hook:'SessionStart',timeoutMs:45000},
    {send:'Reply QUE_E2E_OK only.\r'}, {hook:'UserPromptSubmit',state:'working',timeoutMs:10000}, {hook:'Stop',state:'attention',screen:'QUE_E2E_OK',timeoutMs:15000},
    {send:'Again reply QUE_E2E_OK only.\r'}, {hook:'UserPromptSubmit',state:'working',timeoutMs:10000}, {hook:'Stop',state:'attention',screen:'QUE_E2E_OK',timeoutMs:15000}
  ]}]};
  const manifestPath=path.join(root,'cases.json');await fs.writeFile(manifestPath,JSON.stringify(manifest));
  const runner=spawn(process.execPath,[path.resolve('scripts/harness-e2e/run.mjs'),'--base',ready.base,'--manifest',manifestPath,'--allow-model-requests'],{windowsHide:true,stdio:'inherit'});
  const [code]=await once(runner,'exit');assert.equal(code,0,'Internal PTY/queue integration failed');
  notices=(await api('/api/card-queue')).external.filter(n=>n.kind==='grok');
  assert(notices.every(n=>path.resolve(n.cwd)===root),'Internal session leaked to external notices');
  console.log('PASS: production Grok native registration, external notice, internal two turns, compatibility enabled');
} catch(error) {console.error(error);process.exitCode=1;}
finally {
  backend?.stdin.end();if(backendExit)await backendExit;
  await fs.writeFile(path.join(root,'report.json'),JSON.stringify({reports,requests},null,2));
  await fs.writeFile(path.join(root,'backend.log'),stderr);
  model.closeAllConnections();model.close();console.log('Evidence: '+root);
}
