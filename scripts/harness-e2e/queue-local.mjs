// Full Que API -> PTY -> installed OMP -> hooks -> queue, deterministic local model.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import assert from 'node:assert/strict';
const [exe, omp] = process.argv.slice(2);
assert(exe && omp, 'Usage: queue-local.mjs PATH_TO_QUE_HEADLESS PATH_TO_OMP');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'que-queue-local-'));
const profile = path.join(root, 'profile');
const requests = [];
const model = http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  if (!req.url.includes('chat/completions')) { res.writeHead(404); res.end('{}'); return; }
  const body = JSON.parse(raw); requests.push(body);
  const messages = body.messages || [];
  const userIndex = messages.findLastIndex(m => m.role === 'user');
  const prompt = JSON.stringify(messages[userIndex]?.content || '');
  const answered = messages.slice(userIndex + 1).some(m => m.role === 'tool');
  const ask = prompt.includes('QUE_ASK') && !answered;
  await new Promise(resolve => setTimeout(resolve, 1200));
  const delta = ask ? { role: 'assistant', tool_calls: [{ index: 0, id: 'ask_fixture', type: 'function', function: { name: 'ask', arguments: JSON.stringify({ questions: [{ id: 'choice', question: 'QUE_ASK choose Alpha or Beta', options: [{ label: 'Alpha' }, { label: 'Beta' }] }] }) } }] } : { role: 'assistant', content: prompt.includes('SECOND') ? 'QUE_E2E_SECOND' : 'QUE_E2E_OK' };
  res.setHeader('content-type', 'text/event-stream');
  for (const [d, finish_reason] of [[delta, null], [{}, ask ? 'tool_calls' : 'stop']]) res.write(`data: ${JSON.stringify({ id: 'chatcmpl_test', object: 'chat.completion.chunk', created: 1, model: 'que-test', choices: [{ index: 0, delta: d, finish_reason }] })}\n\n`);
  res.end('data: [DONE]\n\n');
});
model.listen(0, '127.0.0.1'); await once(model, 'listening');
let backend, backendExit, runner;
let stderr = '';
try {
  const env = { ...process.env, PATH: path.dirname(omp) + path.delimiter + process.env.PATH, QUE_BIN_DIR: path.resolve('src-tauri/resources/bin'), PI_OFFLINE: '1', PI_NO_PTY: '1' };
  backend = spawn(exe, [profile], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  backendExit = once(backend, 'exit');
  backend.stderr.on('data', d => stderr += d);
  const ready = await new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('Headless startup timed out: ' + stderr)), 30000);
    backend.once('error', e => { clearTimeout(timer); reject(e); });
    backend.once('exit', code => { clearTimeout(timer); reject(new Error(`Headless exited ${code}: ${stderr}`)); });
    backend.stdout.on('data', d => { buffer += d; for (const line of buffer.split('\n')) { try { const obj = JSON.parse(line); if (obj.base) { clearTimeout(timer); resolve(obj); return; } } catch {} } });
  });
  const agent = path.join(ready.home, '.omp', 'agent'); await fs.mkdir(agent, { recursive: true });
  await fs.writeFile(path.join(agent, 'models.yml'), JSON.stringify({ providers: { 'que-test': { baseUrl: `http://127.0.0.1:${model.address().port}/v1`, api: 'openai-completions', apiKey: 'local-fixture', models: [{ id: 'que-test', name: 'Fixture', reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
  await fs.writeFile(path.join(agent, 'config.yml'), JSON.stringify({ modelRoles: { default: 'que-test/que-test', tiny: 'que-test/que-test' }, defaultThinkingLevel: 'off', startup: { showSplash: false }, lsp: { enabled: false }, ask: { timeout: 0 }, terminal: { notifications: false } }));
  const setting = await fetch(ready.base + '/api/tools/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ externalNotices: true }) });
  assert(setting.ok, await setting.text());
  const complete = [{ hook: 'SessionStart', timeoutMs: 45000 }, { send: 'Reply QUE_E2E_OK.\r' }, { hook: 'UserPromptSubmit', state: 'working', timeoutMs: 10000 }, { hook: 'Stop', state: 'attention', screen: 'QUE_E2E_OK', timeoutMs: 30000 }, { send: 'Reply QUE_E2E_SECOND.\r' }, { hook: 'UserPromptSubmit', state: 'working', timeoutMs: 10000 }, { hook: 'Stop', state: 'attention', screen: 'QUE_E2E_SECOND', timeoutMs: 30000 }];
  const manifest = { cases: [
    { name: 'OMP internal two turns', kind: 'omp', mode: 'internal', steps: complete },
    { name: 'OMP ask attention and resume', kind: 'omp', mode: 'internal', steps: [{ hook: 'SessionStart', timeoutMs: 45000 }, { send: 'QUE_ASK ask me to choose Alpha or Beta.\r' }, { hook: 'PreToolUse', state: 'attention', screen: 'Alpha', timeoutMs: 30000 }, { waitMs: 600, state: 'attention' }, { send: '\r' }, { hook: 'PostToolUse', state: 'working', timeoutMs: 10000 }, { hook: 'Stop', state: 'attention', screen: 'QUE_E2E_OK', timeoutMs: 30000 }] },
    { name: 'OMP external auto-discovery', kind: 'omp', mode: 'external', command: `"${omp}" --allow-home`, steps: [{ screen: 'Fixture|que-test', timeoutMs: 45000 }, { send: 'Reply QUE_E2E_OK.\r' }, { externalState: 'attention', screen: 'QUE_E2E_OK', timeoutMs: 30000 }] }
  ] };
  const manifestPath = path.join(root, 'cases.json'); await fs.writeFile(manifestPath, JSON.stringify(manifest));
  runner = spawn(process.execPath, [path.resolve('scripts/harness-e2e/run.mjs'), '--base', ready.base, '--manifest', manifestPath, '--allow-model-requests'], { windowsHide: true, stdio: 'inherit' });
  const [code] = await once(runner, 'exit'); assert.equal(code, 0, 'Que queue integration suite failed');
  console.log('PASS: Que queue integration through actual installed OMP and local provider');
} catch (error) { console.error(error); process.exitCode = 1; }
finally {
  backend?.stdin.end(); if (backendExit) await backendExit;
  await fs.writeFile(path.join(root, 'backend.log'), stderr);
  await fs.writeFile(path.join(root, 'requests.json'), JSON.stringify(requests, null, 2));
  model.closeAllConnections(); model.close();
  console.log('Isolated profile and provider evidence: ' + root);
}
