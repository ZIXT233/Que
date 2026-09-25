const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const pluginDir = __dirname;
const settingsScript = path.join(pluginDir, 'card-settings.cjs');
const settings = spawnSync(process.execPath, [settingsScript, pluginDir], {
  encoding: 'utf8',
  windowsHide: true,
});
if (settings.error || settings.status !== 0) {
  if (settings.error) process.stderr.write(`Que Qwen Code: ${settings.error.message}\n`);
  if (settings.stderr) process.stderr.write(settings.stderr);
  process.exit(settings.status || 1);
}

const env = { ...process.env, QWEN_CODE_SYSTEM_DEFAULTS_PATH: settings.stdout.trim() };
const args = process.argv.slice(2);
let command = 'qwen';
let launchArgs = args;
if (process.platform === 'win32') {
  const readEnv = name => Object.entries(env).find(([key]) => key.toUpperCase() === name)?.[1] || '';
  const dirs = readEnv('PATH').split(path.delimiter).filter(Boolean);
  const extensions = readEnv('PATHEXT').split(';').filter(Boolean);
  if (!extensions.length) extensions.push('.COM', '.EXE', '.BAT', '.CMD');
  const executable = dirs.flatMap(dir => extensions.map(ext => path.join(dir, `qwen${ext.toLowerCase()}`)))
    .find(file => { try { return fs.statSync(file).isFile(); } catch { return false; } });
  if (!executable) {
    process.stderr.write('Unable to start Qwen Code CLI (qwen): command not found on PATH\n');
    process.exit(1);
  }
  const npmEntry = path.join(path.dirname(executable), 'node_modules', '@qwen-code', 'qwen-code', 'cli-entry.js');
  const npmShim = /\.cmd$/i.test(executable) && fs.existsSync(npmEntry)
    && fs.readFileSync(executable, 'utf8').replaceAll('\\', '/').includes('node_modules/@qwen-code/qwen-code/cli-entry.js');
  if (npmShim) {
    // npm's batch shim can corrupt Unicode and shell metacharacters in paths.
    command = process.execPath;
    launchArgs = [npmEntry, ...args];
  } else if (/\.(cmd|bat)$/i.test(executable)) {
    if (/[^\x20-\x7E]|[&%()^!]/.test(executable)) {
      process.stderr.write('Unable to start Qwen Code CLI: batch launcher path cannot be passed through cmd safely; use the official npm package or standalone executable\n');
      process.exit(1);
    }
    command = readEnv('COMSPEC') || 'cmd.exe';
    launchArgs = ['/d', '/s', '/c', 'call', executable, ...args];
  } else {
    command = executable;
  }
}
const child = spawn(command, launchArgs, {
  cwd: process.cwd(),
  env,
  stdio: 'inherit',
  windowsHide: true,
});
child.on('error', error => {
  process.stderr.write(`Unable to start Qwen Code CLI (qwen): ${error.message}\n`);
  process.exitCode = 1;
});
child.on('close', (childCode, signal) => {
  process.exitCode = childCode ?? (signal ? 1 : 0);
});
