const fs = require('node:fs');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const Module = require('node:module');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, filename);
const { notifyCardReturn, listenCardReturn, focusMainWindow } = require('../src/lib/card-window.ts');

test('return intent and cancellation reach only main; focus restores minimized main in order', async t => {
  const originalLoad = Module._load;
  const calls = [];
  let listener;
  t.mock.method(Module, '_load', function (name, ...args) {
    if (name === '@tauri-apps/api/event') return { emitTo: async (...args) => calls.push(['event', ...args]) };
    if (name === '@tauri-apps/api/window') return { getCurrentWindow: () => ({ listen: async (name, callback) => { listener = callback; return () => calls.push(['unlisten']); } }) };
    if (name === '@tauri-apps/api/webviewWindow') return { WebviewWindow: { getByLabel: async label => {
      assert.equal(label, 'main');
      return Object.fromEntries(['unminimize', 'show', 'setFocus'].map(method => [method, async () => calls.push([method])]));
    } } };
    return originalLoad.call(this, name, ...args);
  });
  global.window = { queDesktop: {} };
  t.after(() => { delete global.window; });
  const returns = [];
  const unlisten = await listenCardReturn((...args) => returns.push(args));
  await notifyCardReturn('card-123');
  await notifyCardReturn('card-123', true);
  await notifyCardReturn('../invalid');
  assert.deepEqual(calls, [
    ['event', 'main', 'que:card-return', { cardId: 'card-123', cancel: false }],
    ['event', 'main', 'que:card-return', { cardId: 'card-123', cancel: true }],
  ]);
  for (const [, , , payload] of calls) listener({ payload });
  listener({ payload: { cardId: '../invalid' } });
  listener({ payload: null });
  assert.deepEqual(returns, [['card-123', false], ['card-123', true]]);
  await focusMainWindow();
  assert.deepEqual(calls.slice(2), [['unminimize'], ['show'], ['setFocus']]);
  unlisten();
  assert.deepEqual(calls.at(-1), ['unlisten']);
  delete window.queDesktop;
  await notifyCardReturn('browser-tab');
  assert.deepEqual(calls.at(-1), ['unlisten']);
});
