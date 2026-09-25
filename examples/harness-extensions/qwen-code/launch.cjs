const { spawn, spawnSync } = require('node:child_process');
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
const child = spawn('qwen', process.argv.slice(2), {
  cwd: process.cwd(),
  env,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  windowsHide: true,
});
child.on('error', error => {
  process.stderr.write(`Unable to start Qwen Code CLI (qwen): ${error.message}\n`);
  process.exitCode = 1;
});
child.on('close', (childCode, signal) => {
  process.exitCode = childCode ?? (signal ? 1 : 0);
});
