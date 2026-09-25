// Exercise bundled extension discovery and Qwen's Windows launcher from a
// Unicode path without installing Qwen or changing the user's configuration.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

if (process.platform !== 'win32') throw new Error('Windows required');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'que-unicode-path-'));
try {
  const unicode = path.join(root, '中文 空格 & % 路径');
  const bin = path.join(unicode, 'bin');
  const extension = path.join(unicode, 'qwen-code');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(extension);
  const source = path.join(__dirname, '../examples/harness-extensions/qwen-code');
  for (const name of fs.readdirSync(source)) {
    fs.copyFileSync(path.join(source, name), path.join(extension, name));
  }
  assert.ok(fs.existsSync(path.join(extension, 'index.mjs')));

  const runner = path.join(__dirname, '../src-tauri/resources/bin/extension-host.cjs');
  const discovered = spawnSync(process.execPath, [runner, 'discover', path.join(extension, 'index.mjs')], {
    encoding: 'utf8', windowsHide: true,
  });
  assert.equal(discovered.status, 0, discovered.stderr);
  assert.equal(JSON.parse(discovered.stdout).id, 'qwen-code');

  const output = path.join(unicode, 'result.json');
  const recorder = path.join(bin, 'node_modules', '@qwen-code', 'qwen-code', 'cli-entry.js');
  fs.mkdirSync(path.dirname(recorder), { recursive: true });
  fs.writeFileSync(recorder, `require('node:fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify({cwd:process.cwd(),defaults:process.env.QWEN_CODE_SYSTEM_DEFAULTS_PATH,argv:process.argv.slice(2)}));`);
  fs.writeFileSync(path.join(bin, 'qwen.cmd'), '@echo off\r\nrem node_modules\\@qwen-code\\qwen-code\\cli-entry.js\r\nexit /b 99\r\n');
  fs.writeFileSync(path.join(extension, 'card-hooks.json'), '{"hooks":{}}');
  const originalDefaults = path.join(unicode, 'defaults.json');
  fs.writeFileSync(originalDefaults, '{}');
  const env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
    QWEN_CODE_SYSTEM_DEFAULTS_PATH: originalDefaults,
  };
  const launched = spawnSync(process.execPath, [path.join(extension, 'launch.cjs'), '--resume', 'session-1'], {
    cwd: unicode, env, encoding: 'utf8', windowsHide: true, timeout: 10000,
  });
  assert.equal(launched.status, 0, launched.stderr);
  const recorded = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(recorded.cwd, unicode);
  assert.equal(recorded.defaults, path.join(extension, 'card-system-defaults.json'));
  assert.deepEqual(recorded.argv, ['--resume', 'session-1']);

  fs.unlinkSync(recorder);
  fs.writeFileSync(path.join(bin, 'qwen.cmd'), '@echo off\r\nexit /b 99\r\n');
  const batch = spawnSync(process.execPath, [path.join(extension, 'launch.cjs'), '--resume', 'session-2'], {
    cwd: unicode, env, encoding: 'utf8', windowsHide: true, timeout: 10000,
  });
  assert.equal(batch.status, 1);
  assert.match(batch.stderr, /batch launcher path cannot be passed through cmd safely/);

  console.log('PASS Windows Unicode extension discovery and Qwen launcher');
} finally {
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('que-unicode-path-'));
  fs.rmSync(root, { recursive: true, force: true });
}
