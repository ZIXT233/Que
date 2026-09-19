const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { once } = require('node:events');
const assert = require('node:assert/strict');
(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'que-mcp-contract-'));
  const plugin = path.join(root, "profile 中文's", 'harness-plugins', 'codex');
  fs.mkdirSync(plugin, { recursive: true });
  for (const [source, dest] of [['harness-hook.cjs', 'hook.cjs'], ['harness-codex-mcp.cjs', 'codex-mcp.cjs']]) fs.copyFileSync(path.join(__dirname, '../../src-tauri/resources/bin', source), path.join(plugin, dest));
  for (const internal of [false, true]) {
    const sink = path.join(root, internal ? 'internal' : 'external');
    const env = { ...process.env, QUE_EXTERNAL_SIGNAL_DIR: sink };
    for (const k of ['QUE_HARNESS_CHANNEL', 'QUE_HARNESS_SIGNAL_DIR', 'QUE_HARNESS_KIND', 'QUE_HOOK_DEBUG', 'QUE_HOOK_DEBUG_FILE']) delete env[k];
    if (internal) env.QUE_HARNESS_SIGNAL_DIR = sink;
    const child = spawn(process.argv[2] || process.execPath, process.argv[2] ? ['codex-mcp'] : [path.join(plugin, 'codex-mcp.cjs')], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const exit = once(child, 'exit');
    const pending = new Map(); let id = 0, stderr = '';
    child.stderr.on('data', d => stderr += d);
    createInterface({ input: child.stdout }).on('line', line => { const r = JSON.parse(line); pending.get(r.id)?.(r); pending.delete(r.id); });
    const call = async (method, params) => {
      const requestId = ++id;
      const result = new Promise(resolve => pending.set(requestId, resolve));
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
      let timer;
      try { return await Promise.race([result, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('MCP response timeout: ' + stderr)), 5000); })]); }
      finally { clearTimeout(timer); }
    };
    try {
      assert((await call('initialize', {})).result.capabilities.tools);
      assert.equal((await call('tools/list', {})).result.tools[0].name, 'session_state');
      await call('tools/call', { name: 'session_state', arguments: { hook_event_name: 'Stop', session_id: 'wrong-scope', que_scope: internal ? 'external' : 'internal' } });
      for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'Stop', 'UserPromptSubmit', 'Stop']) {
        const r = await call('tools/call', { name: 'session_state', arguments: { hook_event_name: event, que_scope: internal ? 'internal' : 'external', session_id: 'test-session', cwd: root, prompt: '中文 prompt', tool_name: 'Bash', last_assistant_message: 'Done\nnext' } });
        assert(!r.error && !r.result.isError);
      }
      const signals = fs.readdirSync(sink).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(sink, f), 'utf8')));
      assert.equal(signals.length, 8);
      assert(signals.every(s => s.kind === 'codex' && s.sessionId === 'test-session' && Boolean(s.external) === !internal));
      assert.equal(signals.filter(s => s.event === 'UserPromptSubmit')[0].prompt, '中文 prompt');
      assert.equal(signals.filter(s => s.event === 'Stop')[0].replyPreview, internal ? 'Done next' : 'Done\nnext');
    } finally { child.stdin.end(); await exit; }
  }
  console.log('PASS persistent MCP: both sinks, all six events, two turns, Unicode paths and previews. ' + root);
})().catch(e => { console.error(e); process.exitCode = 1; });
