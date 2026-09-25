const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const pluginDir = process.argv[2];
if (!pluginDir) throw Error('Missing Qwen Code plugin directory');

const defaultPath = process.platform === 'darwin'
  ? '/Library/Application Support/QwenCode/system-defaults.json'
  : process.platform === 'win32'
    ? path.join(process.env.ProgramData || 'C:\\ProgramData', 'qwen-code', 'system-defaults.json')
    : path.join('/etc', 'qwen-code', 'system-defaults.json');
const originalPath = process.env.QWEN_CODE_SYSTEM_DEFAULTS_PATH || defaultPath;
const original = fs.existsSync(originalPath)
  ? JSON.parse(fs.readFileSync(originalPath, 'utf8'))
  : {};
const card = JSON.parse(fs.readFileSync(path.join(pluginDir, 'card-hooks.json'), 'utf8'));
if (!original || Array.isArray(original) || typeof original !== 'object') {
  throw Error(`Qwen system defaults must be a JSON object: ${originalPath}`);
}
if (original.hooks !== undefined && (!original.hooks || Array.isArray(original.hooks) || typeof original.hooks !== 'object')) {
  throw Error(`Qwen system default hooks must be a JSON object: ${originalPath}`);
}

const hooks = { ...original.hooks };
for (const [event, entries] of Object.entries(card.hooks)) {
  const existing = hooks[event] ?? [];
  if (!Array.isArray(existing)) throw Error(`Qwen system default hooks.${event} must be an array`);
  hooks[event] = [...existing, ...entries];
}
const merged = { ...original, hooks };
const target = path.join(pluginDir, 'card-system-defaults.json');
const temporary = `${target}.${randomUUID()}.tmp`;
try {
  fs.writeFileSync(temporary, `${JSON.stringify(merged, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  fs.renameSync(temporary, target);
} finally {
  if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
}
process.stdout.write(target);
