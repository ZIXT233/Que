// Actual Codex command-hook executor across a full deterministic model turn.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const { spawn } = require('node:child_process'); const assert = require('node:assert/strict');
const entry = process.argv[2]; assert(entry, 'Usage: codex-turn.cjs PATH_TO_CODEX_JS');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'que-codex-turn-'));
const plugin = path.join(root, 'harness-plugins', 'codex'), sink = path.join(root, 'signals');
for (const dir of [plugin, sink]) fs.mkdirSync(dir, { recursive: true });
fs.copyFileSync(path.resolve(__dirname, '../../src-tauri/resources/bin/harness-hook.cjs'), path.join(plugin, 'hook.cjs'));
// The same safe bare-token form installed on ordinary Windows paths.
const command = `C:/PROGRA~1/nodejs/node.exe ${path.join(plugin, 'hook.cjs').replaceAll('\\', '/')}`;
assert(fs.existsSync('C:/PROGRA~1/nodejs/node.exe'), 'Fixture requires the configured Node alias');
const server = http.createServer(async (req, res) => {
  for await (const chunk of req) {}
  if (!req.url.includes('responses')) { res.writeHead(404); res.end('{}'); return; }
  res.setHeader('content-type', 'text/event-stream');
  const content = { type: 'output_text', text: 'QUE_E2E_OK', annotations: [], logprobs: [] };
  const item = { id: 'msg_test', type: 'message', role: 'assistant', status: 'completed', content: [content] };
  const response = { id: 'resp_test', object: 'response', status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
  let sequence_number = 0;
  const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence_number++, ...data })}\n\n`);
  send('response.created', { response: { ...response, status: 'in_progress', output: [] } });
  send('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
  send('response.content_part.added', { item_id: item.id, output_index: 0, content_index: 0, part: { ...content, text: '' } });
  send('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: content.text });
  send('response.output_text.done', { item_id: item.id, output_index: 0, content_index: 0, text: content.text });
  send('response.content_part.done', { item_id: item.id, output_index: 0, content_index: 0, part: content });
  send('response.output_item.done', { output_index: 0, item }); send('response.completed', { response }); res.end();
});
server.listen(0, '127.0.0.1', async () => {
  let stdout = '', stderr = '', timer, code;
  const hookTimings = [], pending = new Map();
  let stderrLines = '';
  try {
    const home = path.join(root, 'codex-home'); fs.mkdirSync(home);
    const args = [entry, 'exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check', '--dangerously-bypass-hook-trust', '--enable', 'hooks', '-C', root, '-m', 'gpt-5.4', '-c', 'model_provider="que_test"', '-c', `model_providers.que_test={name="local fixture",base_url="http://127.0.0.1:${server.address().port}",wire_api="responses",request_max_retries=0,stream_max_retries=0}`];
    for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop']) args.push('-c', `hooks.${event}=[{hooks=[{type="command",command=${JSON.stringify(command)},timeout=15}]}]`);
    args.push('Reply QUE_E2E_OK without using any tools.');
    const env = { ...process.env, CODEX_HOME: home, QUE_HARNESS_KIND: 'codex', QUE_HARNESS_SIGNAL_DIR: sink, QUE_HOOK_DEBUG: '1' };
    delete env.QUE_HARNESS_CHANNEL;
    const child = spawn(process.execPath, args, { env, cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); child.stdin.end();
    child.stdout.on('data', d => stdout += d); child.stderr.on('data', d => {
      stderr += d; stderrLines += d;
      const lines = stderrLines.split('\n'); stderrLines = lines.pop();
      for (const line of lines) {
        const match = line.trim().match(/^hook: (\w+)(?: (Completed|Failed))?$/);
        if (!match) continue;
        if (!match[2]) pending.set(match[1], Date.now());
        else {
          const started = pending.get(match[1]);
          assert(started, `Missing start marker: ${line}`);
          hookTimings.push({ event: match[1], outcome: match[2], started, finished: Date.now(), ms: Date.now() - started });
          pending.delete(match[1]);
        }
      }
    });
    code = await new Promise((resolve, reject) => { timer = setTimeout(() => spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }), 45000); child.on('error', reject); child.on('close', resolve); });
    assert.equal(code, 0, stderr); assert(stdout.includes('QUE_E2E_OK'), stdout + stderr);
    assert(!/hook[^\n]*(?:Failed|exit.*code 1)/i.test(stdout + stderr), stderr);
    const signals = fs.readdirSync(sink).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(sink, f), 'utf8')));
    for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop']) assert.equal(signals.filter(s => s.event === event).length, 1, JSON.stringify(signals));
    assert.equal(hookTimings.length, 3, 'Every hook must have CLI start/end timing');
    console.log(JSON.stringify(hookTimings));
    for (const timing of hookTimings) assert(timing.ms < 3000, `${timing.event} blocked Codex for ${timing.ms}ms (budget 3000ms)`);
    console.log('PASS: actual Codex SessionStart, submit and Stop hooks across a complete local-model turn');
  } catch (e) { console.error(e); process.exitCode = 1; }
  finally { clearTimeout(timer); fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify({ code, hookTimings, stdout, stderr }, null, 2)); server.closeAllConnections(); server.close(); console.log('Report: ' + root); }
});
