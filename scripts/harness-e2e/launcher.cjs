// Native launcher integration: real processes/pipes and non-ASCII spaced paths.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const {spawnSync} = require('node:child_process');
const assert = require('node:assert/strict');
assert(process.argv[2], 'Pass the compiled hook-launcher executable');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'que-launcher-'));
const dir = path.join(root, "John Smith 中文's", 'harness-plugins', 'claude');
fs.mkdirSync(dir, {recursive:true});
const exe = path.join(dir, 'external-hook.exe'); fs.copyFileSync(process.argv[2], exe);
fs.writeFileSync(path.join(dir,'external-node.txt'), process.execPath);
fs.copyFileSync(path.join(__dirname,'../../src-tauri/resources/bin/harness-hook.cjs'), path.join(dir,'hook.cjs'));
const sink = path.join(root,'signals'); fs.mkdirSync(sink);
const env = {...process.env, QUE_EXTERNAL_SIGNAL_DIR:sink};
for(const key of ['GROK_HOOK_EVENT','QUE_HARNESS_SIGNAL_DIR','QUE_HARNESS_CHANNEL','QUE_HARNESS_KIND']) delete env[key];
const run = extra => {
  const start = performance.now();
  const r = spawnSync(exe, [], {env:{...env,...extra}, cwd:root, windowsHide:true, timeout:3000, encoding:'utf8', input:JSON.stringify({hook_event_name:'UserPromptSubmit',session_id:'launcher-test',prompt:'中文 & spaces',cwd:root})});
  assert.equal(r.status,0,r.stderr || r.error?.message); assert.equal(r.stdout,'');
  return Math.round(performance.now()-start);
};
try {
  const normal = run({});
  let files = fs.readdirSync(sink); assert.equal(files.length,1);
  const signal = JSON.parse(fs.readFileSync(path.join(sink,files[0]),'utf8'));
  assert.equal(signal.kind,'claude'); assert.equal(signal.prompt,'中文 & spaces'); assert.equal(signal.external,true);
  const imported = run({GROK_HOOK_EVENT:'user_prompt_submit'});
  const cursorImported = run({CURSOR_VERSION:'fixture'});
  const internal = run({QUE_HARNESS_KIND:'claude',QUE_HARNESS_SIGNAL_DIR:sink});
  assert.equal(fs.readdirSync(sink).length,1,'Imported/ambient copies must not duplicate signals');
  console.log(JSON.stringify({passed:true,normalMs:normal,grokImportedMs:imported,cursorImportedMs:cursorImported,internalAmbientMs:internal,root}));
} finally {
  assert.equal(path.dirname(root),path.resolve(os.tmpdir())); assert(path.basename(root).startsWith('que-launcher-'));
  fs.rmSync(root,{recursive:true,force:true,maxRetries:3,retryDelay:100});
}
