// Process-level protocol checks, not a substitute for installed CLI timings.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const binary=process.argv[2]; assert(binary,'Pass que-hook.exe');
const root=fs.mkdtempSync(path.join(os.tmpdir(),"que native 中文's "));
const dir=path.join(root,'harness-plugins','fixtures');fs.mkdirSync(dir,{recursive:true});
const exe=path.join(dir,'que-hook.exe');fs.copyFileSync(binary,exe);
const cleanEnv={...process.env};for(const key of Object.keys(cleanEnv))if(key.startsWith('QUE_')||key.startsWith('CURSOR_')||key==='GROK_HOOK_EVENT')delete cleanEnv[key];
function run(args,payload,env={}) {return new Promise((resolve,reject)=>{
 const child=spawn(exe,args,{env:{...cleanEnv,...env},windowsHide:true,stdio:['pipe','pipe','pipe']});let out='',err='';
 const timer=setTimeout(()=>{child.kill();reject(Error('stdin stayed open: hook failed to finish'));},5000);
 child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>err+=d);child.on('error',reject);
 child.on('close',code=>{clearTimeout(timer);resolve({code,out,err});});
 // Deliberately keep stdin OPEN; handlers must not wait for EOF.
 child.stdin.on('error',()=>{});child.stdin.write(JSON.stringify(payload));
});}
(async()=>{
 for(const kind of ['claude','codebuddy','cursor','grok','antigravity','gemini']){
  for(const internal of [false,true]){
   const sink=path.join(root,kind+(internal?'-internal':'-external')); const event=kind==='cursor'?'beforeSubmitPrompt':kind==='antigravity'?'Stop':kind==='gemini'?'BeforeAgent':kind==='grok'?'user_prompt_submit':'UserPromptSubmit';
   const payload={hook_event_name:event,session_id:'test-session',prompt:'中文 prompt',fullyIdle:false,cwd:root};
   const result=await run([kind,event],payload,{[internal?'QUE_HARNESS_SIGNAL_DIR':'QUE_EXTERNAL_SIGNAL_DIR']:sink});
   assert.equal(result.code,0,JSON.stringify(result));
   const signals=fs.readdirSync(sink).filter(f=>f.endsWith('.json')).map(f=>JSON.parse(fs.readFileSync(path.join(sink,f),'utf8')));
   assert.equal(signals.length,1);assert.equal(signals[0].kind,kind);assert.equal(Boolean(signals[0].external),!internal);assert.equal(signals[0].sessionId,'test-session');
   if(kind==='antigravity')assert.equal(signals[0].fullyIdle,false);
   if(kind==='cursor')assert.equal(JSON.parse(result.out).continue,true);
  }
 }
 for(const event of ['preToolUse','beforeShellExecution','beforeMCPExecution']){const r=await run(['cursor',event],{session_id:'permission'},{QUE_EXTERNAL_SIGNAL_DIR:path.join(root,'permissions')});assert.equal(r.code,0);assert.equal(JSON.parse(r.out).permission,'allow');}
 const rejected=await run(['cursor','UnknownEvent'],{session_id:'unknown'},{QUE_EXTERNAL_SIGNAL_DIR:path.join(root,'unknown')});assert.notEqual(rejected.code,0);assert(!fs.existsSync(path.join(root,'unknown')));
 console.log('PASS native runtime: six harnesses, internal/external routing, open stdin, verdicts, Unicode paths. '+root);
})().catch(e=>{console.error(e);process.exitCode=1});
