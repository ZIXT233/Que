// Real OMP RPC tool/UI execution against a deterministic local model.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const http = require('node:http'), { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const exe = process.argv[2];
assert(exe, 'Usage: node omp-ask.cjs PATH_TO_OMP');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'que-omp-ask-'));
const agent = path.join(root, 'agent'), sink = path.join(root, 'signals');
fs.mkdirSync(agent); fs.mkdirSync(sink);
const signals = () => fs.readdirSync(sink).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(sink, f), 'utf8')));
let requests = 0;
const server = http.createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  if (!req.url.includes('chat/completions')) { res.writeHead(404); res.end('{}'); return; }
  const input = JSON.parse(body);
  fs.writeFileSync(path.join(root, `request-${++requests}.json`), JSON.stringify(input, null, 2));
  const answered = input.messages.some(m => m.role === 'tool');
  const delta = answered ? { role: 'assistant', content: 'QUE_E2E_OK' } : { role: 'assistant', tool_calls: [{ index: 0, id: 'ask-1', type: 'function', function: { name: 'ask', arguments: JSON.stringify({ questions: [{ id: 'choice', question: 'Choose a fixture option', options: [{ label: 'Alpha' }, { label: 'Beta' }] }] }) } }] };
  res.setHeader('content-type', 'text/event-stream');
  for (const [d, finish_reason] of [[delta, null], [{}, answered ? 'stop' : 'tool_calls']]) res.write(`data: ${JSON.stringify({ id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 1, model: 'que-test', choices: [{ index: 0, delta: d, finish_reason }] })}\n\n`);
  res.end('data: [DONE]\n\n');
});
server.listen(0, '127.0.0.1', async () => {
  let child, timer;
  const frames = []; let stderr = '', failure, uiSeen = false, completed = false;
  try {
    fs.writeFileSync(path.join(agent, 'models.yml'), JSON.stringify({ providers: { 'que-test': { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'local-fixture', api: 'openai-completions', models: [{ id: 'que-test', name: 'Fixture', reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
    const env = { ...process.env, HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: '1', QUE_HARNESS_KIND: 'omp', QUE_HARNESS_SIGNAL_DIR: sink };
    delete env.QUE_HARNESS_CHANNEL; delete env.OMP_PROFILE;
    child = spawn(exe, ['--mode', 'rpc-ui', '--provider', 'que-test', '--model', 'que-test', '--no-session', '--no-title', '--no-lsp', '--no-rules', '--no-skills', '--tools', 'ask', '--thinking', 'off', '--extension', path.resolve(__dirname, '../../src-tauri/resources/bin/harness-pi.mjs')], { env, cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const send = value => child.stdin.write(JSON.stringify(value) + '\n');
    const handle = async frame => {
      frames.push(frame);
      if (frame.type === 'ready') send({ id: 'prompt-1', type: 'prompt', message: 'Ask me to choose Alpha or Beta, then reply QUE_E2E_OK.' });
      if (frame.type === 'extension_ui_request' && frame.method === 'select') {
        uiSeen = true;
        await new Promise(resolve => setTimeout(resolve, 600));
        const pending = signals();
        assert(pending.some(s => s.event === 'PreToolUse' && s.tool === 'ask'), 'Missing ask attention signal while dialog is open');
        assert(!pending.some(s => s.event === 'PostToolUse' || s.event === 'Stop'), 'Ask settled before user answered');
        assert(frame.options.includes('Alpha'), JSON.stringify(frame));
        send({ type: 'extension_ui_response', id: frame.id, value: 'Alpha' });
      }
      if (frame.type === 'agent_end' && frame.isTerminal !== false) { completed = true; child.stdin.end(); }
    };
    let buffer = '';
    child.stdout.on('data', chunk => { buffer += chunk; let end; while ((end = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (!line.trim()) continue; try { Promise.resolve(handle(JSON.parse(line))).catch(e => { failure = e; child.stdin.end(); }); } catch (e) { failure = e; child.stdin.end(); } } });
    child.stderr.on('data', chunk => stderr += chunk);
    const code = await new Promise((resolve, reject) => {
      timer = setTimeout(() => { failure = new Error('OMP RPC timed out'); spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }); }, 30000);
      child.on('error', reject); child.on('close', resolve);
    });
    if (failure) throw failure;
    assert.equal(code, 0); assert(uiSeen, 'No real ask UI request'); assert(completed, 'No terminal agent_end');
    const events = signals();
    for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']) assert.equal(events.filter(s => s.event === event).length, 1, JSON.stringify(events));
    assert(JSON.stringify(frames).includes('QUE_E2E_OK'));
    console.log('PASS: real OMP ask stays pending until RPC answer, then resumes and settles');
  } catch (e) { console.error(e); process.exitCode = 1; }
  finally { clearTimeout(timer); fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify({ frames, stderr, signals: signals(), uiSeen, completed, error: failure?.message }, null, 2)); server.closeAllConnections(); server.close(); console.log('Report: ' + root); }
});
