// Installed Cursor hook executor + actual PowerShell, without model/API requests.
// Version-specific adapter: fail if the bundle layout changes. This is not a full CLI turn.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const Module = require('node:module'), { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const [bundle] = process.argv.slice(2);
assert(bundle, 'Usage: cursor-executor.cjs PATH_TO_CURSOR_INDEX_JS');
const source = fs.readFileSync(bundle, 'utf8');
const entry = 'var __webpack_exports__=__webpack_require__("./src/main.tsx")';
assert(source.includes(entry), 'Unsupported bundle layout');
const loaded = new Module(bundle, module); loaded.filename = bundle; loaded.paths = Module._nodeModulePaths(path.dirname(bundle));
loaded._compile(source.replace(entry, 'module.exports=__webpack_require__'), bundle);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "que cursor 中文's executor-"));
const sink = path.join(root, 'signals'); fs.mkdirSync(sink);
// Mirror windows_hook_command: bare tokens when safe, encoded PowerShell otherwise.
const safeToken = token => token.length > 0 && [...token].every(c => /[A-Za-z0-9]/.test(c) || ':/\\._-~'.includes(c));
const hookCommand = (dir, arg) => {
  const tokens = [process.execPath, path.join(dir, 'hook.cjs'), arg].filter(Boolean);
  if (tokens.every(safeToken)) return tokens.map(t => t.replaceAll('\\', '/')).join(' ');
  const quote = s => `'${s.replaceAll("'", "''")}'`;
  const script = `$ErrorActionPreference='Stop'; [Console]::InputEncoding=[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); & ${tokens.map(quote).join(' ')}; exit $LASTEXITCODE`;
  return `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`;
};
const transport = {
  async *execute(_context, command, options) {
    const script = `[Console]::InputEncoding=[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); ${command}; exit $LASTEXITCODE`;
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { cwd: options.workingDirectory, env: { ...process.env, ...options.env, QUE_EXTERNAL_SIGNAL_DIR: sink }, windowsHide: true, signal: options.signal, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => stdout += d); child.stderr.on('data', d => stderr += d);
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    yield { type: 'stdout', data: Buffer.from(stdout) }; yield { type: 'stderr', data: Buffer.from(stderr) }; yield { type: 'exit', code };
  }
};
(async () => {
  for (const file of fs.readdirSync(path.dirname(bundle))) if (/^\d+\.index\.js$/.test(file)) await loaded.exports.e(Number(file.split('.')[0]));
  const exports = loaded.exports('../hooks-exec/dist/index.js');
  const Executor = Object.values(exports).find(value => value?.prototype?.executeCommandScript);
  assert(Executor, 'Unsupported Cursor hook executor');
  const validate = loaded.exports('../hooks/dist/index.js').RV;
  assert(validate, 'Unsupported Cursor config validator');
  const results = [];
  for (const kind of ['cursor', 'claude']) {
    const dir = path.join(root, 'harness-plugins', kind); fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(path.resolve(__dirname, '../../src-tauri/resources/bin/harness-hook.cjs'), path.join(dir, 'hook.cjs'));
    for (const mode of ['stdin', 'argv']) {
      const executor = new Executor({}, root, { cursor_version: '2026.09.18-fixture' }, transport, undefined, undefined, undefined, { commandHookPayloadTransport: mode });
      const command = hookCommand(dir, kind === 'cursor' ? 'beforeSubmitPrompt' : '--que-ambient');
      const configCheck = validate({version:1,hooks:{beforeSubmitPrompt:[{command,timeout:15,hooks:[]}]}});
      assert(configCheck.isValid, JSON.stringify(configCheck));
      const result = await executor.executeCommandScript({ script: { command, timeout: 15 }, cwd: root, request: { hook_event_name: 'beforeSubmitPrompt', session_id: 'cursor-fixture', prompt: '中文 fixture', workspace_roots: [root] } });
      assert.equal(result.exitCode, 0, JSON.stringify(result));
      if (kind === 'cursor') assert.equal(JSON.parse(result.stdout).continue, true);
      else assert.equal(result.stdout, '');
      results.push({ kind, mode, ...result });
    }
  }
  const signals = fs.readdirSync(sink).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(sink, f), 'utf8')));
  assert.equal(signals.length, 2); assert(signals.every(s => s.kind === 'cursor'));
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify({ results, signals }, null, 2));
  console.log(JSON.stringify({ passed: true, results, report: root }));
})().catch(error => { console.error(error); process.exitCode = 1; });
