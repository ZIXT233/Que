// Fast extension contract check; deliberately NOT called a real-CLI E2E test.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import observe from '../../src-tauri/resources/bin/harness-pi.mjs';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'que-pi-contract-'));
const saved = Object.fromEntries(['QUE_HARNESS_KIND', 'QUE_HARNESS_CHANNEL', 'QUE_HARNESS_SIGNAL_DIR'].map(k => [k, process.env[k]]));
try {
  for (const key of Object.keys(saved)) delete process.env[key];
  const handlers = new Map();
  const entry = path.join(root, 'enabled'); fs.writeFileSync(entry, 'enabled');
  observe({ on: (event, callback) => handlers.set(event, callback) }, {kind: 'omp', signalDir: root, enabledFile: entry});
  assert(!handlers.has('ui_prompt_start'), 'OMP must use real tool events');
  const ctx = { cwd: root, sessionManager: { getSessionId: () => 'test-session', getSessionName: () => 'test', buildSessionContext: () => ({messages: []}) } };
  for (const [name, event] of [['session_start', {}], ['before_agent_start', {prompt: 'test'}], ['agent_start', {}], ['tool_call', {toolName: 'ask'}], ['tool_result', {toolName: 'ask'}], ['agent_end', {}]]) handlers.get(name)(event, ctx);
  const read = () => fs.readdirSync(root).filter(n => n.endsWith('.json')).map(n => JSON.parse(fs.readFileSync(path.join(root,n), 'utf8')));
  handlers.get('before_agent_start')({prompt: 'maintenance'}, ctx);
  handlers.get('agent_end')({isTerminal: false}, ctx);
  assert.equal(read().filter(e => e.event === 'Stop').length, 1, 'maintenance must not settle the turn');
  handlers.get('agent_end')({isTerminal: true}, ctx);
  const events = read().filter(e => e.prompt !== 'maintenance');
  assert.equal(events.length, 6);
  assert.deepEqual(events.map(e => e.event).sort(), ['SessionStart','UserPromptSubmit','PreToolUse','PostToolUse','Stop','Stop'].sort());
  for (const e of events) { assert.equal(e.external,true); assert.equal(e.kind,'omp'); assert.equal(e.workspaceRoot,root); }
  assert.equal(events.find(e => e.event === 'PreToolUse').tool, 'ask');
  fs.unlinkSync(entry); handlers.get('session_start')({},ctx); assert.equal(read().length,7);
  console.log('PASS: OMP event mapping, single submit, external routing and disable gate (contract only)');
} finally {
  for (const [key,value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert(path.basename(root).startsWith('que-pi-contract-'));
  fs.rmSync(root, { recursive: true, force: true });
}
