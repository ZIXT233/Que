// Que's private runner for user-owned Node extensions. The public API is the
// register callback documented in docs/harness/extensions.md and extensions.zh-CN.md.
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');

async function registered(entry) {
  let definition;
  const que = { register(value) {
    if (definition) throw Error('An extension must register exactly once');
    definition = value;
  } };
  const imported = await import(pathToFileURL(entry).href);
  if (typeof imported.default !== 'function') throw Error('Default export must be a register function');
  await imported.default(que);
  if (!definition || definition.type !== 'harness' || definition.apiVersion !== 1) {
    throw Error('Expected a version 1 harness registration');
  }
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(definition.id)) throw Error('Invalid harness id');
  if (typeof definition.name !== 'string' || !definition.name.trim()) throw Error('Missing harness name');
  if (typeof definition.launch !== 'function') throw Error('Missing launch function');
  if (definition.externalHooks !== undefined &&
    (!definition.externalHooks || typeof definition.externalHooks.install !== 'function' || typeof definition.externalHooks.uninstall !== 'function')) {
    throw Error('externalHooks requires install and uninstall functions');
  }
  return definition;
}

function command(value) {
  if (!value || typeof value.command !== 'string' || !value.command || !Array.isArray(value.args)
    || !value.args.every(arg => typeof arg === 'string')) throw Error('Expected {command,args}');
  return { command: value.command, args: value.args };
}

function hookCommand(input, event) {
  if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(event)) throw Error('Invalid hook event');
  if (typeof input?.hookCommand !== 'string' || !input.hookCommand) throw Error('Missing Que hook command');
  if (!input.hookWindows) return `${input.hookCommand} ${event}`;
  const node = input.hookNode;
  const hook = input.hookPath;
  if (typeof node !== 'string' || !node || typeof hook !== 'string' || !hook) throw Error('Missing Windows hook path');
  const bare = value => /^[A-Za-z0-9:/\\._~-]+$/.test(value);
  if (bare(node) && bare(hook)) return `${node.replaceAll('\\', '/')} ${hook.replaceAll('\\', '/')} ${event}`;
  const quote = value => `'${value.replaceAll("'", "''")}'`;
  const script = `$ErrorActionPreference='Stop'; [Console]::InputEncoding=[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); & ${[node, hook, event].map(quote).join(' ')}; exit $LASTEXITCODE`;
  return `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`;
}

function iconDataUrl(entry, name) {
  if (name === undefined) return undefined;
  if (typeof name !== 'string' || !/^[A-Za-z0-9_-]+\.svg$/.test(name)) {
    throw Error('Extension icon must name an SVG file beside index.mjs');
  }
  const file = path.join(path.dirname(entry), name);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > 64 * 1024) throw Error('Extension icon must be a regular SVG file under 64 KiB');
  const svg = fs.readFileSync(file);
  if (!/<svg(?:\s|>)/.test(svg.toString('utf8'))) throw Error('Extension icon is not SVG');
  return `data:image/svg+xml;base64,${svg.toString('base64')}`;
}

function emit(kind, value, options = {}) {
  if (!value || typeof value !== 'object' || typeof value.event !== 'string') throw Error('Invalid hook signal');
  if (value.sessionId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value.sessionId)) throw Error('Invalid session id');
  const cardDir = process.env.QUE_HARNESS_SIGNAL_DIR;
  const token = process.env.QUE_HARNESS_CHANNEL;
  const externalDir = !cardDir && !token && (options.externalSignalDir || process.env.QUE_HARNESS_EXTERNAL_SIGNAL_DIR);
  const signal = { ...value, kind, at: Date.now(), external: externalDir ? true : undefined };
  const dir = cardDir || externalDir;
  if (!dir && !token) return false;
  if (token) {
    try {
      const frame = `\x1b]777;que;${Buffer.from(JSON.stringify({ token, signal })).toString('base64')}\x07`;
      const output = process.env.TMUX ? `\x1bPtmux;${frame.replace(/\x1b/g, '\x1b\x1b')}\x1b\\` : frame;
      fs.writeFileSync(process.env.QUE_HARNESS_TTY || '/dev/tty', output);
    } catch (error) {
      if (!dir) return false;
    }
  }
  if (dir) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = path.join(dir, `${signal.at}-${randomUUID()}.json`);
    const temporary = `${target}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(signal), { mode: 0o600 });
    fs.renameSync(temporary, target);
  }
  return true;
}

async function run(mode, entry, arg, input) {
  const definition = await registered(entry);
  const pluginDir = input?.pluginDir || path.dirname(entry);
  if (mode === 'discover') return { id: definition.id, name: definition.name, description: definition.description || '', external: !!definition.externalHooks, iconDataUrl: iconDataUrl(entry, definition.icon) };
  if (mode === 'launch') return command(await definition.launch({ pluginDir, cwd: input?.cwd, remote: input?.remote }));
  if (mode === 'resume') {
    if (typeof definition.resume !== 'function') throw Error('Harness does not support resume');
    return command(await definition.resume({ pluginDir, cwd: input?.cwd, remote: input?.remote, sessionId: input?.sessionId }));
  }
  if (mode === 'install') {
    if (typeof definition.installHooks === 'function') {
      await definition.installHooks({
        pluginDir,
        home: input.home,
        remote: input.remote,
        hookCommand: event => hookCommand(input, event),
      });
    }
    return { installed: true };
  }
  if (mode === 'install-external' || mode === 'uninstall-external') {
    if (!definition.externalHooks) throw Error('Harness does not support external hooks');
    const ctx = {
      pluginDir,
      home: input.home,
      externalSignalDir: input.externalSignalDir,
      hookCommand: event => hookCommand(input, event),
    };
    await definition.externalHooks[mode === 'install-external' ? 'install' : 'uninstall'](ctx);
    return { installed: mode === 'install-external' };
  }
  if (mode === 'hook') {
    if (typeof definition.onHook !== 'function') throw Error('Harness does not implement onHook');
    const scope = !process.env.QUE_HARNESS_SIGNAL_DIR && !process.env.QUE_HARNESS_CHANNEL && process.env.QUE_HARNESS_EXTERNAL_SIGNAL_DIR ? 'external' : 'card';
    const result = await definition.onHook({ event: arg, input, scope }, { pluginDir, emit: value => emit(definition.id, value) });
    return result;
  }
  throw Error('Unknown extension action');
}

async function readStdin() {
  let raw = '';
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (raw.length > 1024 * 1024) throw Error('Extension input too large');
  }
  return raw.trim() ? JSON.parse(raw) : {};
}

async function main() {
  const [mode, entry, arg] = process.argv.slice(2);
  // Stdout is the runner's response channel (and the agent's hook reply).
  console.log = console.info = (...values) => console.error(...values);
  const input = mode === 'hook' || mode === 'install' || mode === 'install-external' || mode === 'uninstall-external' || mode === 'launch' || mode === 'resume'
    ? await readStdin() : {};
  const result = await run(mode, entry, arg, input);
  if (mode === 'hook') {
    if (typeof result === 'string') process.stdout.write(result);
    else if (result && typeof result.stdout === 'string') process.stdout.write(result.stdout);
  } else {
    process.stdout.write(JSON.stringify(result) + '\n');
  }
}

if (require.main === module) main().catch(error => {
  process.stderr.write(`Que extension: ${error.message || error}\n`);
  process.exitCode = 1;
});

module.exports = { run, emit, main };
