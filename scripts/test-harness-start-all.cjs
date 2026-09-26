const fs = require('node:fs');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, filename);
const { createHarnessBatchStarter } = require('../src/lib/harness/start-all.ts');
const { harnessErrorText } = require('../src/lib/harness/errors.ts');
const card = (id, workspaceId = 'local', extra = {}) => ({ id, workspaceId, harness: { state: 'exited', ...extra } });
const workspaces = [
  { id: 'local', kind: 'local' },
  { id: 'dev', kind: 'ssh', sshHost: 'dev-host' },
  { id: 'dev2', kind: 'ssh', sshHost: 'dev-host' },
  { id: 'a10', kind: 'ssh', sshHost: 'a10-host' },
  { id: 'third', kind: 'ssh', sshHost: 'third-host' },
];
const tick = () => new Promise(resolve => setImmediate(resolve));
const error = code => Object.assign(new Error(code), { code });

test('slow SSH cannot delay local launches; same host is serialized and concurrency capped', async () => {
  const cards = [card('dev-1', 'dev'), card('dev-2', 'dev2'), card('gpu', 'a10'), card('third', 'third'), card('local-1'), card('local-2')];
  const pending = new Map();
  const calls = [];
  let max = 0;
  const run = createHarnessBatchStarter()({ getCards: () => cards, workspaces, launch: (_, { id }) => {
    calls.push(id);
    return new Promise(resolve => { pending.set(id, () => { pending.delete(id); resolve(); }); max = Math.max(max, pending.size); });
  } });
  await tick();
  assert.deepEqual(calls, ['local-1', 'dev-1', 'gpu']);
  pending.get('local-1')();
  await tick();
  assert(calls.includes('local-2'));
  assert(!calls.includes('dev-2'));
  pending.get('dev-1')();
  await tick();
  assert(calls.includes('dev-2'));
  while (pending.size) { [...pending.values()].forEach(resolve => resolve()); await tick(); }
  assert.deepEqual(await run, []);
  assert.equal(max, 3);
});

test('repeated batch clicks join one promise; later batch can run again', async () => {
  const start = createHarnessBatchStarter();
  let calls = 0, complete;
  const options = { getCards: () => [card('one')], workspaces, launch: () => { calls++; return new Promise(resolve => { complete = resolve; }); } };
  const first = start(options);
  assert.equal(start(options), first);
  await tick();
  assert.equal(calls, 1);
  complete();
  await first;
  const next = start(options);
  assert.notEqual(next, first);
  await tick();
  assert.equal(calls, 2);
  complete();
  await next;
});

test('rechecks live card state before launching the next card', async () => {
  let cards = ['first', 'running', 'archived', 'deleted', 'resumed'].map(id => card(id));
  const calls = [];
  const failures = await createHarnessBatchStarter()({ getCards: () => cards, workspaces, launch: async (action, { id }) => {
    calls.push([id, action]);
    if (id === 'first') cards = [card('running', 'local', { state: 'working' }), { ...card('archived'), archivedAt: 1 }, card('resumed', 'local', { providerSessionId: 'session-id' })];
  } });
  assert.deepEqual(calls, [['first', 'harness_reopen'], ['resumed', 'harness_resume']]);
  assert.deepEqual(failures, []);
});

test('one unreachable host times out once, reports skipped cards, and leaves other hosts running', async () => {
  const cards = [card('dev-1', 'dev'), card('dev-2', 'dev2'), card('gpu', 'a10'), card('local')];
  const calls = [];
  const failures = await createHarnessBatchStarter()({ getCards: () => cards, workspaces, launch: async (_, { id }) => {
    calls.push(id);
    if (id === 'dev-1') throw error('TIMEOUT');
  } });
  assert.deepEqual(calls.sort(), ['dev-1', 'gpu', 'local']);
  assert.deepEqual(failures.map(({ card, skipped, error }) => [card.id, skipped, error.code]), [['dev-1', false, 'TIMEOUT'], ['dev-2', true, 'TIMEOUT']]);
});

test('backend race guards are benign, but CLI errors remain failures and do not block a host', async () => {
  const codes = ['HARNESS_STILL_RUNNING', 'HARNESS_LAUNCH_IN_PROGRESS', 'HARNESS_CLI_MISSING_REMOTE', null];
  const cards = codes.map((_, i) => card(String(i), 'dev'));
  const calls = [];
  const failures = await createHarnessBatchStarter()({ getCards: () => cards, workspaces, launch: async (_, { id }) => {
    calls.push(id);
    if (codes[Number(id)]) throw error(codes[Number(id)]);
  } });
  assert.deepEqual(calls, ['0', '1', '2', '3']);
  assert.deepEqual(failures.map(({ card }) => card.id), ['2']);
});

test('SSH timeout text is translated and preserves the underlying detail', () => {
  assert.equal(harnessErrorText({ code: 'TIMEOUT', detail: 'connect timed out after 8s' }, key => key === 'machines.error.TIMEOUT' ? '连接超时' : key), '连接超时（connect timed out after 8s）');
  assert.equal(harnessErrorText(error('HARNESS_STILL_RUNNING'), key => key), 'harness.error.HARNESS_STILL_RUNNING');
});
