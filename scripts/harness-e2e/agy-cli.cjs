// Live installed AGY turn. Uses existing authentication/registration; no config writes.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawn } = require('node:child_process'); const assert = require('node:assert/strict');
assert(process.argv.includes('--allow-model-requests'), 'This check uses the installed AGY account; pass --allow-model-requests');
const exe = process.argv[2];
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'que-agy-cli-'));
const sink = path.join(root, 'signals'); fs.mkdirSync(sink);
const started = Date.now();
const child = spawn(exe, ['--print', 'Reply exactly QUE_E2E_OK. Do not use tools or access any files.', '--mode', 'plan', '--print-timeout', '30s', '--log-file', path.join(root, 'agy.log')], { cwd: root, env: { ...process.env, QUE_HARNESS_KIND: 'antigravity', QUE_HARNESS_SIGNAL_DIR: sink, QUE_HARNESS_CHANNEL: '' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
child.stdin.end(); let stdout = '', stderr = ''; const timeline = [];
child.stdout.on('data', d => { stdout += d; timeline.push({ ms: Date.now() - started, stream: 'stdout', text: String(d) }); });
child.stderr.on('data', d => { stderr += d; timeline.push({ ms: Date.now() - started, stream: 'stderr', text: String(d) }); });
const timer = setTimeout(() => spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }), 40000);
child.on('error', e => { clearTimeout(timer); console.error(e); process.exitCode = 1; });
child.on('close', code => {
  clearTimeout(timer);
  const signals = fs.readdirSync(sink).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(sink, f), 'utf8')));
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify({ code, ms: Date.now() - started, stdout, stderr, timeline, signals }, null, 2));
  try { assert.equal(code, 0, stderr); assert(stdout.includes('QUE_E2E_OK'), stdout); assert(signals.some(s => s.event === 'PreInvocation')); assert(signals.some(s => ['Stop', 'PostInvocation'].includes(s.event))); assert(!/hook[^\n]*(?:failed|timed out|exit.*code [1-9])/i.test(stdout + stderr)); console.log('PASS: installed AGY complete turn with real hooks'); }
  catch (e) { console.error(e); process.exitCode = 1; }
  console.log('Report: ' + root);
});
