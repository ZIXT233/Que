// Windows-only integration checks. Uses an isolated home/signal directory; no
// model requests, user hook registration, or GUI. Run with node on Windows.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn,spawnSync} = require('node:child_process');
if (process.platform !== 'win32') throw new Error('Windows required');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'que-hook-check-'));
const psQuote = value => `'${value.replaceAll("'", "''")}'`;
const run = (exe, args, options = {}) => new Promise((resolve,reject) => {
  const start = performance.now();
  const {input,...rest}=options;
  const child=spawn(exe,args,{windowsHide:true,stdio:['pipe','pipe','pipe'],...rest});
  let stdout='',stderr='',timedOut=false;
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data',s=>stdout+=s); child.stderr.on('data',s=>stderr+=s);
  child.stdin.on('error',()=>{}); child.stdin.end(input);
  const timer=setTimeout(()=>{timedOut=true;spawnSync('taskkill.exe',['/pid',String(child.pid),'/t','/f'],{windowsHide:true});},30000);
  child.on('error',e=>{clearTimeout(timer);reject(e)});
  child.on('close',status=>{clearTimeout(timer);const ms=Math.round(performance.now()-start);console.log(`${path.basename(exe)}: ${ms} ms, exit ${status}`);timedOut?reject(new Error(`Timeout: ${stderr}`)):resolve({status,stdout,stderr,ms});});
});
async function main() { try {
  const home = path.join(root, 'home');
  const signal = path.join(root, 'signals');
  const plugin = path.join(root, "John Smith & 中文's", '.que-dev', 'harness-plugins', 'cursor');
  fs.mkdirSync(home, {recursive:true}); fs.mkdirSync(signal); fs.mkdirSync(plugin, {recursive:true});
  const hook = path.join(plugin, 'hook.cjs');
  fs.copyFileSync(path.join(__dirname, '../src-tauri/resources/bin/harness-hook.cjs'), hook);
  const env = {...process.env, CODEX_HOME: home, QUE_HARNESS_SIGNAL_DIR:signal, QUE_HARNESS_KIND:'cursor', QUE_HARNESS_DEBUG:'0', QUE_HARNESS_CHANNEL:'', QUE_HOOK_DEBUG:'0'};
  const payload = JSON.stringify({hook_event_name:'beforeSubmitPrompt',conversation_id:'que-test',prompt:'中文 & % !',cwd:root});
  const args = `${psQuote(process.execPath)} ${psQuote(hook)} 'beforeSubmitPrompt'`;
  const encoded = Buffer.from(`$ErrorActionPreference='Stop'; [Console]::InputEncoding=[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); & ${args}; exit $LASTEXITCODE`, 'utf16le').toString('base64');
  const old = `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encoded}`;
  // A BOM makes the fixture unambiguous to both Windows PowerShell 5.1 and pwsh.
  // The installed Cursor transport does not specify Get-Content -Encoding.
  const payloadFile = path.join(root, 'payload.json'); fs.writeFileSync(payloadFile,'\uFEFF'+payload);
  // Mirrors Cursor's installed Windows temp-file transport, including call operator.
  const cursor = command => `$OutputEncoding = [System.Text.Encoding]::UTF8; Get-Content -LiteralPath ${psQuote(payloadFile)} -Raw | & { $input | ${command} }`;
  const samples = {};
  const cursorCases=process.argv.includes('--config-only') ? [] : [['cursor-old',old],['cursor-direct',`& ${args}`]];
  for(const [name] of cursorCases) samples[name]=[];
  // Alternate old/new to reduce cold-start and changing machine-load bias.
  for(let i=0;i<3;i++) {
    for (const [name, command] of cursorCases) {
      console.log(name);
      const r=await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',cursor(command)],{env,cwd:root});
      assert.equal(r.status,0,r.stderr); assert.equal(JSON.parse(r.stdout).continue,true);
      samples[name].push(r.ms);
    }
  }
  const bash = process.env.QUE_TEST_BASH || 'C:/Program Files/Git/bin/bash.exe';
  if (fs.existsSync(bash) && !process.argv.includes('--config-only') && !process.argv.includes('--cursor-only')) {
    const q = value => "'"+value.replaceAll('\\','/').replaceAll("'", "'\\''")+"'";
    const command = `${q(process.execPath)} ${q(hook)} beforeSubmitPrompt`;
    for (const [name,line] of [['codebuddy-old',old],['codebuddy-direct',command]]) {
      samples[name]=[];
      for(let i=0;i<3;i++) {
        const r=await run(bash,['-c',line],{env,input:payload,cwd:root});
        assert.equal(r.status,0,r.stderr); assert.equal(JSON.parse(r.stdout).continue,true); samples[name].push(r.ms);
      }
    }
  } else if (!process.argv.includes('--config-only') && !process.argv.includes('--cursor-only')) console.log('CodeBuddy shell benchmark skipped: set QUE_TEST_BASH to Git Bash');
  const files = fs.readdirSync(signal).filter(n=>n.endsWith('.json'));
  assert.ok(process.argv.includes('--config-only') || files.length >= 6);
  for(const file of files) {
    const event=JSON.parse(fs.readFileSync(path.join(signal,file),'utf8'));
    assert.equal(event.prompt,'中文 & % !');
  }
  const npmRoot = path.join(process.env.APPDATA, 'npm');
  const entry = path.join(npmRoot,'node_modules/@openai/codex/bin/codex.js');
  if(fs.existsSync(entry) && !process.argv.includes('--cursor-only')) {
    const override='hooks.Stop=[{hooks=[{type="command",command="pushd . && echo QUE_CONFIG_ONLY",timeout=15}]}]';
    // Reproduce npm's argument forwarding with a recorder, never accidentally
    // launching an interactive Codex if the broken shim loses `features list`.
    const fixtureEntry=path.join(root,'node_modules/@openai/codex/bin/codex.js');
    fs.mkdirSync(path.dirname(fixtureEntry),{recursive:true});
    fs.writeFileSync(fixtureEntry,"console.log('QUE_ARGV='+JSON.stringify(process.argv.slice(2)))");
    const fixtureShim=path.join(root,'codex.cmd');
    fs.copyFileSync(path.join(npmRoot,'codex.cmd'),fixtureShim);
    const configArgs=['--enable','hooks','-c',override,'features','list'];
    const oldResult=await run('cmd.exe',['/d','/s','/c','call',fixtureShim,...configArgs],{env,cwd:root});
    const oldLine=oldResult.stdout.split(/\r?\n/).find(line=>line.startsWith('QUE_ARGV='));
    assert.ok(oldLine,oldResult.stderr);
    const oldArgs=JSON.parse(oldLine.slice('QUE_ARGV='.length));
    assert.notDeepEqual(oldArgs,configArgs,'Expected the existing npm/cmd argument corruption to reproduce');
    console.log(`Old npm shim corrupted arguments: ${JSON.stringify(oldArgs)}`);
    const captured=await run(process.execPath,[fixtureEntry,...configArgs],{env,cwd:root});
    assert.deepEqual(JSON.parse(captured.stdout.trim().slice('QUE_ARGV='.length)),configArgs);
    const r=await run(process.execPath,[entry,'--enable','hooks','-c',override,'features','list'],{env,cwd:root});
    assert.equal(r.status,0,r.stderr);
    assert.ok(!r.stderr.includes('invalid type'),r.stderr);
    console.log('Codex official JS entrypoint: nested hook config parsed successfully');
  }
  console.log(JSON.stringify({samplesMs:samples,signals:files.length},null,2));
} finally {
  // Only the mkdtemp directory owned by this check is removed.
  assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('que-hook-check-'));
  try { fs.rmSync(root,{recursive:true,force:true,maxRetries:3,retryDelay:100}); }
  catch(error) { console.error(`Cleanup failed (${root}): ${error.message}`); }
} }
main().catch(error=>{console.error(error);process.exitCode=1});
