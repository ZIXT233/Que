// Exercise the installed Codex hook executor, not a hand-written shell imitation.
// Local unavailable provider prevents model requests; stop after SessionStart.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const args = process.argv.slice(2);
const option = name => args[args.indexOf(name) + 1];
assert(args.includes('--entry') && args.includes('--command'), 'Usage: node codex-startup.cjs --entry /path/to/codex.js --command "actual registered hook command" [--expect-failure]');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'que-codex-e2e-'));
const signals = path.join(root, 'signals'); fs.mkdirSync(signals);
const codexHome = path.join(root, 'codex-home'); fs.mkdirSync(codexHome);
const hook = option('--command');
const cliArgs = [option('--entry'), 'exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check',
  '--dangerously-bypass-hook-trust', '--enable', 'hooks', '-C', root,
  '-c', 'model_provider="que_test"',
  '-c', 'model_providers.que_test={name="local test endpoint",base_url="http://127.0.0.1:1",wire_api="responses",request_max_retries=0,stream_max_retries=0}',
  '-c', `hooks.SessionStart=[{hooks=[{type="command",command=${JSON.stringify(hook)},timeout=10}]}]`, 'Reply OK. Do not use tools.'];
const child = spawn(process.execPath, cliArgs, { windowsHide: true, stdio: ['pipe','pipe','pipe'],
  env: { ...process.env, CODEX_HOME: codexHome, QUE_HARNESS_KIND: 'codex', QUE_HARNESS_SIGNAL_DIR: signals, QUE_HARNESS_CHANNEL: '' } });
child.stdin.end();
let output = '', started, finished, outcome, killing = false;
const stop = () => {
  if (killing) return; killing = true;
  if (process.platform === 'win32') spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
  else child.kill('SIGTERM');
};
const timer = setTimeout(stop, 30000);
for (const stream of [child.stdout, child.stderr]) stream.on('data', data => {
  output += data.toString();
  if (!started && /hook: SessionStart(?:\r?\n|$)/.test(output)) started = Date.now();
  const match = output.match(/hook: SessionStart (Completed|Failed)/);
  if (match && !finished) { finished = Date.now(); outcome = match[1]; stop(); }
});
child.on('error', error => { clearTimeout(timer); console.error(error); process.exitCode = 1; });
child.on('close', () => {
  clearTimeout(timer);
  const events = fs.readdirSync(signals).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(signals, f), 'utf8')));
  const expected = args.includes('--expect-failure') ? 'Failed' : 'Completed';
  const passed = outcome === expected && (expected === 'Failed' ? events.length === 0 : events.length === 1 && events[0].kind === 'codex' && events[0].event === 'SessionStart');
  const result = { passed, outcome, expected, hookMs: finished && started ? finished - started : null, events, root };
  fs.writeFileSync(path.join(root, 'cli.log'), output);
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = passed ? 0 : 1;
});
