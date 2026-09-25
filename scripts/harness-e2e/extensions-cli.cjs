// Installed Pi/OMP + actual extension discovery + local deterministic model.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {pathToFileURL}=require('node:url');const {spawn}=require('node:child_process');const assert=require('node:assert/strict');
const args=process.argv.slice(2),opt=k=>args[args.indexOf(k)+1];
assert(args.includes('--pi-entry')&&args.includes('--omp'),'Required --pi-entry PATH --omp EXE');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'que-extension-中文-'));
const observer=pathToFileURL(path.join(__dirname,'../../src-tauri/resources/bin/harness-pi.mjs')).href;
const server=http.createServer(async(req,res)=>{
  for await(const chunk of req){};
  if(!req.url.includes('chat/completions')){res.writeHead(404);res.end('{}');return;}
  res.setHeader('content-type','text/event-stream');
  for(const [delta,finish_reason] of [[{role:'assistant',content:'QUE_E2E_OK'},null],[{},'stop']])res.write(`data: ${JSON.stringify({id:'chatcmpl-test',object:'chat.completion.chunk',created:1,model:'que-test',choices:[{index:0,delta,finish_reason}]})}\n\n`);
  res.end('data: [DONE]\n\n');
});
async function run(kind,internal){
  const dir=path.join(root,`${kind}-${internal}`),agent=path.join(dir,'agent'),sink=path.join(dir,'signals');
  fs.mkdirSync(path.join(agent,'extensions'),{recursive:true});fs.mkdirSync(sink);
  const entry=path.join(agent,'extensions','que-external.ts');
  const model={id:'que-test',name:'Fixture',reasoning:false,input:['text'],contextWindow:32000,maxTokens:512,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
  const provider={baseUrl:`http://127.0.0.1:${server.address().port}/v1`,apiKey:'local-fixture',api:'openai-completions',models:[model]};
  // JSON is a YAML subset. OMP resolves provider IDs before loading extensions.
  fs.writeFileSync(path.join(agent,kind==='pi'?'models.json':'models.yml'),JSON.stringify({providers:{'que-test':provider}}));
  fs.writeFileSync(entry,`import observer from ${JSON.stringify(observer)}; export default function(api){if(process.env.QUE_HARNESS_SIGNAL_DIR||process.env.QUE_HARNESS_CHANNEL)return;return observer(api,${JSON.stringify({kind,signalDir:sink,enabledFile:entry})});}`);
  const env={...process.env,PI_CODING_AGENT_DIR:agent,HOME:dir,USERPROFILE:dir,PI_OFFLINE:'1',PI_NO_PTY:'1'};
  for(const k of ['QUE_HARNESS_KIND','QUE_HARNESS_SIGNAL_DIR','QUE_HARNESS_CHANNEL','OMP_PROFILE'])delete env[k];
  if(internal)Object.assign(env,{QUE_HARNESS_KIND:kind,QUE_HARNESS_SIGNAL_DIR:sink});
  let argv=['--provider','que-test','--model','que-test','--no-session','--no-tools','--thinking','off','-p','Reply QUE_E2E_OK'];
  if(internal)argv.unshift('--extension',path.join(__dirname,'../../src-tauri/resources/bin/harness-pi.mjs'));
  if(kind==='pi')argv.unshift(opt('--pi-entry'),'--offline','--no-context-files');else argv.unshift('--no-title','--no-lsp','--no-rules','--no-skills');
  const start=Date.now();const result=await new Promise((resolve,reject)=>{
    const child=spawn(kind==='pi'?process.execPath:opt('--omp'),argv,{env,cwd:dir,windowsHide:true,stdio:['pipe','pipe','pipe']});child.stdin.end();let stdout='',stderr='',timedOut=false;
    child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);
    const t=setTimeout(()=>{timedOut=true;spawn('taskkill.exe',['/pid',String(child.pid),'/t','/f'],{windowsHide:true,stdio:'ignore'})},30000);
    child.on('error',e=>{clearTimeout(t);reject(e)});child.on('close',code=>{clearTimeout(t);resolve({code,stdout,stderr,timedOut})});
  });
  const signals=fs.readdirSync(sink).filter(f=>f.endsWith('.json')).map(f=>JSON.parse(fs.readFileSync(path.join(sink,f),'utf8')));
  const report={kind,internal,...result,ms:Date.now()-start,signals};fs.writeFileSync(path.join(dir,'report.json'),JSON.stringify(report,null,2));
  assert.equal(result.code,0,JSON.stringify(report));assert(!result.timedOut);assert(result.stdout.includes('QUE_E2E_OK'),JSON.stringify(report));
  for(const event of ['SessionStart','UserPromptSubmit','Stop'])assert.equal(signals.filter(s=>s.event===event).length,1,JSON.stringify(report));
  assert(signals.every(s=>s.kind===kind&&Boolean(s.external)===!internal),JSON.stringify(report));
  console.log(JSON.stringify({kind,internal,passed:true,ms:report.ms,events:signals.map(s=>s.event)}));
}
server.listen(0,'127.0.0.1',async()=>{try{for(const kind of ['pi','omp'])for(const internal of [false,true])await run(kind,internal);}catch(e){console.error(e);process.exitCode=1;}finally{server.closeAllConnections();server.close();console.log('Reports: '+root);}});
