// Real installed Claude/Grok, isolated profiles, deterministic local model server.
// No GUI, real-account credentials or paid model requests.
const fs=require('node:fs'), path=require('node:path'), os=require('node:os'), http=require('node:http');
const {spawn,spawnSync}=require('node:child_process');
const assert=require('node:assert/strict');
const argv=process.argv.slice(2), opt=k=>argv[argv.indexOf(k)+1];
assert(argv.includes('--launcher')&&argv.includes('--claude')&&argv.includes('--grok'),'Required: --launcher EXE --claude EXE --grok EXE');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'que compat 中文-'));
const home=path.join(root,'home'), sink=path.join(root,'signals');
for(const dir of [home,sink,path.join(home,'.claude'),path.join(home,'.grok','hooks')])fs.mkdirSync(dir,{recursive:true});
const plugin=kind=>path.join(root,'harness-plugins',kind);
for(const kind of ['claude','grok','cursor']){fs.mkdirSync(plugin(kind),{recursive:true});fs.copyFileSync(path.join(__dirname,'../../src-tauri/resources/bin/harness-hook.cjs'),path.join(plugin(kind),'hook.cjs'));}
// Opt-in reproducer: current Grok misparses native Cursor entries as Claude
// matcher groups. Keep this failing case visible, not silently skipped/passed.
if(argv.includes('--cursor-compat-fixture') || argv.includes('--cursor-compatible')) {
  fs.mkdirSync(path.join(home,'.cursor'),{recursive:true});
  fs.writeFileSync(path.join(home,'.cursor','hooks.json'),JSON.stringify({version:1,hooks:Object.fromEntries(['sessionStart','beforeSubmitPrompt','stop'].map(event=>[event,[{command:`node '${path.join(plugin('cursor'),'hook.cjs').replaceAll("'","''")}' '${event}'`,timeout:5,...(argv.includes('--cursor-compatible')?{hooks:[]}: {})}]]))}));
}
const launcher=path.join(plugin('claude'),'external-hook.exe');fs.copyFileSync(opt('--launcher'),launcher);fs.writeFileSync(path.join(plugin('claude'),'external-node.txt'),process.execPath);
// Test the same short profile prefix used by installation; keep the ownership suffix.
const shortRoot=spawnSync('cmd.exe',['/d','/c','for %I in ("%QUE_FIXTURE_ROOT%") do @echo %~sI'],{env:{...process.env,QUE_FIXTURE_ROOT:root},encoding:'utf8',windowsHide:true,windowsVerbatimArguments:true});
assert.equal(shortRoot.status,0,shortRoot.stderr);
const registeredLauncher=path.join(shortRoot.stdout.trim(),'harness-plugins','claude','external-hook.exe');
const events=['SessionStart','UserPromptSubmit','Stop'];
const hookSettings=command=>({hooks:Object.fromEntries(events.map(e=>[e,[{hooks:[{type:'command',command,args:[],timeout:5}]}]]))});
fs.writeFileSync(path.join(home,'.claude','settings.json'),JSON.stringify(hookSettings(launcher)));
fs.writeFileSync(path.join(home,'.grok','hooks','que-session-state.json'),JSON.stringify(hookSettings(`node "${path.join(plugin('grok'),'hook.cjs').replaceAll('\\','/')}"`)));
let requests=0;
let grokBaseline;
const server=http.createServer(async(req,res)=>{
  let body='';for await(const c of req)body+=c;
  if(req.url.includes('/models')){res.setHeader('content-type','application/json');res.end('{"object":"list","data":[]}');return;}
  if(req.url.includes('/responses')){
    requests++;
    const response={id:'resp_test',object:'response',status:'completed',output:[{id:'msg_test',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'QUE_E2E_OK',annotations:[]}]}],usage:{input_tokens:10,output_tokens:4,total_tokens:14}};
    res.setHeader('content-type','text/event-stream');res.end(`event: response.completed\ndata: ${JSON.stringify({type:'response.completed',response})}\n\n`);return;
  }
  if(req.url.includes('count_tokens')){res.setHeader('content-type','application/json');res.end('{"input_tokens":10}');return;}
  if(!req.url.includes('messages')&&!req.url.includes('chat/completions')){res.writeHead(404);res.end('{}');return;}
  requests++;
  res.setHeader('content-type','text/event-stream');
  const send=(type,data)=>res.write(`event: ${type}\ndata: ${JSON.stringify({type,...data})}\n\n`);
  if(req.url.includes('messages')){
    send('message_start',{message:{id:'msg_test',type:'message',role:'assistant',model:'claude-sonnet-4-6',content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:10,output_tokens:0}}});
    send('content_block_start',{index:0,content_block:{type:'text',text:''}});
    send('content_block_delta',{index:0,delta:{type:'text_delta',text:'QUE_E2E_OK'}});
    send('content_block_stop',{index:0});send('message_delta',{delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:4}});send('message_stop',{});
  }else{
    const part=(delta,finish_reason=null)=>res.write(`data: ${JSON.stringify({id:'chatcmpl-test',object:'chat.completion.chunk',created:1,model:'que-test',choices:[{index:0,delta,finish_reason}]})}\n\n`);
    part({role:'assistant',content:'QUE_E2E_OK'});part({},'stop');res.write('data: [DONE]\n\n');
  }
  res.end();
});
const run=async(kind,compat,legacy=false)=>{
  const base=`http://127.0.0.1:${server.address().port}`;
  fs.writeFileSync(path.join(home,'.grok','config.toml'),`[cli]\nuse_leader = false\n[compat.claude]\nhooks = ${compat}\n[compat.cursor]\nhooks = ${compat}\n[model.que-test]\nmodel = "que-test"\nbase_url = "${base}/v1"\napi_key = "local-fixture"\nname = "Local fixture"\n`);
  for(const file of fs.readdirSync(sink))fs.unlinkSync(path.join(sink,file));
  const env={...process.env,HOME:home,USERPROFILE:home,CLAUDE_CONFIG_DIR:path.join(home,'.claude'),GROK_HOME:path.join(home,'.grok'),QUE_EXTERNAL_SIGNAL_DIR:sink,ANTHROPIC_API_KEY:'local-fixture',ANTHROPIC_BASE_URL:base,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',XAI_API_KEY:'local-fixture'};
  Object.assign(env,{GROK_XAI_API_BASE_URL:base+'/v1',GROK_MODELS_LIST_URL:base+'/v1/models',GROK_CLI_CHAT_PROXY_BASE_URL:base+'/v1',GROK_DISABLE_AUTOUPDATER:'1',GROK_MEMORY:'0',GROK_WORKFLOWS:'0'});
  for(const k of ['QUE_HARNESS_KIND','QUE_HARNESS_SIGNAL_DIR','QUE_HARNESS_CHANNEL','GROK_HOOK_EVENT','ANTHROPIC_AUTH_TOKEN','CLAUDE_CODE_OAUTH_TOKEN','CLAUDECODE'])delete env[k];
  const registration=hookSettings(legacy?process.execPath:registeredLauncher);
  if(legacy)for(const group of Object.values(registration.hooks))for(const h of group[0].hooks){h.args=[path.join(plugin('claude'),'hook.cjs')];h.timeout=1;}
  fs.writeFileSync(path.join(home,'.claude','settings.json'),JSON.stringify(registration));
  if(kind==='grok'&&compat){
    const inspected=spawnSync(opt('--grok'),['inspect','--json'],{env,cwd:root,windowsHide:true,encoding:'utf8',timeout:10000});
    assert.equal(inspected.status,0,inspected.stderr);
    const config=JSON.parse(inspected.stdout);
    assert(config.hooks.some(h=>h.target===(legacy?process.execPath:registeredLauncher)),'Grok must discover the actual Claude registration');
    assert(config.externalCompat.cells.some(c=>c.vendor==='claude'&&c.surface==='hooks'&&c.enabled),'Compatibility must be enabled');
  }
  const args=kind==='claude'?['-p','Reply QUE_E2E_OK only.','--no-session-persistence','--strict-mcp-config','--tools','','--model','claude-sonnet-4-6']:['--cwd',root,'--model','que-test','--max-turns','1','--tools','','-p','Reply QUE_E2E_OK only.'];
  const start=Date.now(),before=requests;
  const result=await new Promise((resolve,reject)=>{
    const child=spawn(opt('--'+kind),args,{env,cwd:root,windowsHide:true,stdio:['pipe','pipe','pipe']});child.stdin.end();let stdout='',stderr='',timedOut=false;
    child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);
    const timer=setTimeout(()=>{timedOut=true;spawn('taskkill.exe',['/pid',String(child.pid),'/t','/f'],{windowsHide:true,stdio:'ignore'});},30000);
    child.on('error',e=>{clearTimeout(timer);reject(e)});child.on('close',code=>{clearTimeout(timer);resolve({code,stdout,stderr,timedOut})});
  });
  const signals=fs.readdirSync(sink).filter(f=>f.endsWith('.json')).map(f=>JSON.parse(fs.readFileSync(path.join(sink,f),'utf8')));
  const report={kind,compat,legacy,...result,ms:Date.now()-start,requests:requests-before,signals};
  fs.writeFileSync(path.join(root,`${kind}-${compat}-${legacy}.json`),JSON.stringify(report,null,2));
  if(legacy){assert(/hook[^\n]*(?:failed|timed out)/i.test(result.stdout+result.stderr),'Negative control must reproduce a hook failure: '+JSON.stringify(report));console.log(JSON.stringify({kind,compat,legacy,negativeControlPassed:true}));return;}
  assert.equal(result.code,0,JSON.stringify(report));assert(!result.timedOut);assert(result.stdout.includes('QUE_E2E_OK'),JSON.stringify(report));
  assert(signals.some(e=>e.event==='Stop'),JSON.stringify(report));assert(signals.every(e=>e.kind===kind),JSON.stringify(report));
  const counts=Object.fromEntries(events.map(event=>[event,signals.filter(e=>e.event===event).length]));
  assert.equal(counts.SessionStart,1);assert.equal(counts.UserPromptSubmit,1);
  if(kind==='claude')assert.equal(counts.Stop,1);
  else if(!compat)grokBaseline=counts;else assert.deepEqual(counts,grokBaseline,'Compatibility must not add signals; Grok may emit Stop both at turn end and shutdown');
  assert(!/hook[^\n]*(?:failed|timed out)/i.test(result.stderr),result.stderr);
  console.log(JSON.stringify({kind,compat,passed:true,ms:report.ms,signals:signals.map(s=>s.event)}));
};
server.listen(0,'127.0.0.1',async()=>{try{await run('claude',false);if(!argv.includes('--only-claude')){await run('grok',false);await run('grok',true,true);await run('grok',true);}}catch(e){console.error(e);process.exitCode=1;}finally{server.closeAllConnections();server.close();console.log('Reports: '+root);}});
