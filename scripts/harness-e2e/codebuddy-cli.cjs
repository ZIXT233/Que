// Installed CodeBuddy's ambient settings discovery; no Que process or GUI.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const { spawn } = require('node:child_process'); const assert = require('node:assert/strict');
const entry = process.argv[2]; assert(entry, 'Usage: node codebuddy-cli.cjs PATH_TO_CODEBUDDY_JS');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'que-codebuddy-cli-'));
const home = path.join(root, 'home'), config = path.join(home, '.codebuddy'), sink = path.join(root, 'signals'), plugin = path.join(root, 'harness-plugins', 'codebuddy');
for (const dir of [config, sink, plugin]) fs.mkdirSync(dir, { recursive: true });
fs.copyFileSync(path.resolve(__dirname, '../../src-tauri/resources/bin/harness-hook.cjs'), path.join(plugin, 'hook.cjs'));
const quote = s => "'" + s.replaceAll('\\', '/').replaceAll("'", "'\\''") + "'";
const native = process.argv[3];
if (native) fs.copyFileSync(native, path.join(plugin, 'que-hook.exe'));
const command = (native ? [path.join(plugin, 'que-hook.exe'), 'codebuddy'] : [process.execPath, path.join(plugin, 'hook.cjs')]).map(quote).join(' ');
const events = ['SessionStart', 'UserPromptSubmit', 'Stop'];
fs.writeFileSync(path.join(config, 'settings.json'), JSON.stringify({ hooks: Object.fromEntries(events.map(e => [e, [{ hooks: [{ type: 'command', command, timeout: 15 }] }]])) }));
const requests = [];
const server = http.createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  requests.push({ url: req.url, body });
  if (!req.url.includes('messages') && !req.url.includes('chat/completions')) { res.setHeader('content-type', 'application/json'); res.end('{"data":[],"code":0}'); return; }
  res.setHeader('content-type', 'text/event-stream');
  const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  if (req.url.includes('messages')) {
    send('message_start', { message: { id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
    send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'QUE_E2E_OK' } });
    send('content_block_stop', { index: 0 }); send('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } }); send('message_stop', {});
  } else {
    for (const [delta, finish_reason] of [[{ role: 'assistant', content: 'QUE_E2E_OK' }, null], [{}, 'stop']]) res.write(`data: ${JSON.stringify({ id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 1, model: 'que-test', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    res.write('data: [DONE]\n\n');
  }
  res.end();
});
server.listen(0, '127.0.0.1', async () => {
  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEBUDDY_CONFIG_DIR: config, CODEBUDDY_BASE_URL: `http://127.0.0.1:${server.address().port}`, CODEBUDDY_API_KEY: 'local-fixture', QUE_EXTERNAL_SIGNAL_DIR: sink };
  for (const key of ['QUE_HARNESS_KIND', 'QUE_HARNESS_SIGNAL_DIR', 'QUE_HARNESS_CHANNEL']) delete env[key];
  let stdout = '', stderr = '', timer, code;
  try {
    const child = spawn(process.execPath, [entry, '-p', 'Reply QUE_E2E_OK', '--tools', '', '--model', 'claude-sonnet-4-6'], { env, cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); child.stdin.end();
    child.stdout.on('data', d => stdout += d); child.stderr.on('data', d => stderr += d);
    code = await new Promise((resolve, reject) => { timer = setTimeout(() => spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }), 30000); child.on('error', reject); child.on('close', resolve); });
    assert.equal(code, 0, stderr); assert(stdout.includes('QUE_E2E_OK'), stdout + stderr);
    const signals = fs.readdirSync(sink).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(sink, f), 'utf8')));
    for (const event of events) assert.equal(signals.filter(s => s.event === event).length, 1, JSON.stringify(signals));
    assert(signals.every(s => s.external && s.kind === 'codebuddy'));
    console.log('PASS: actual CodeBuddy external settings hooks, full local-model turn');
  } catch (e) { console.error(e); process.exitCode = 1; }
  finally { clearTimeout(timer); fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify({ code, stdout, stderr, requests }, null, 2)); server.closeAllConnections(); server.close(); console.log('Report: ' + root); }
});
