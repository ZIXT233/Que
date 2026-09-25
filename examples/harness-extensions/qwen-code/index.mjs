import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'Stop',
  'StopFailure',
  'SessionEnd',
];
const OWNER = 'que-qwen-code-external';
const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
const MAX_TURNS = 80;
const MAX_TURN_CHARS = 16_000;
const MAX_SIGNAL_TURN_CHARS = 96_000;

function cleanText(value, limit = MAX_TURN_CHARS) {
  if (typeof value !== 'string') return undefined;
  const text = Array.from(value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')).slice(0, limit).join('').trim();
  return text || undefined;
}

function messageText(message) {
  if (!Array.isArray(message?.parts)) return undefined;
  return cleanText(message.parts
    .filter(part => typeof part?.text === 'string' && part.thought !== true)
    .map(part => part.text)
    .join('\n'));
}

function appendTurn(turns, role, text) {
  const value = cleanText(text);
  if (!value) return;
  const last = turns.at(-1);
  if (last?.role === role && last.text === value) return;
  turns.push({ role, text: value });
  while (turns.length > MAX_TURNS
      || turns.reduce((length, turn) => length + turn.text.length, 0) > MAX_SIGNAL_TURN_CHARS) {
    turns.shift();
  }
}

/** Read Qwen's own JSONL conversation; no model request or Que-owned cache. */
export function readSessionSnapshot(input) {
  const sessionId = input?.session_id;
  const file = input?.transcript_path;
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(sessionId)
      || typeof file !== 'string' || !path.isAbsolute(file)
      || path.basename(file) !== `${sessionId}.jsonl` || path.basename(path.dirname(file)) !== 'chats') {
    return {};
  }
  let content;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return {};
    const fd = fs.openSync(file, 'r');
    try {
      const start = stat.size > MAX_TRANSCRIPT_BYTES
        ? Math.max(256 * 1024, stat.size - MAX_TRANSCRIPT_BYTES)
        : 0;
      const size = stat.size - start;
      const bytes = Buffer.alloc(size);
      const count = fs.readSync(fd, bytes, 0, size, start);
      content = bytes.subarray(0, count).toString('utf8');
      if (start > 0) {
        content = content.slice(content.indexOf('\n') + 1);
        // Preserve the original title when the recent conversation exceeds the cap.
        const head = Buffer.alloc(Math.min(stat.size, 256 * 1024));
        const headCount = fs.readSync(fd, head, 0, head.length, 0);
        content = `${head.subarray(0, headCount).toString('utf8').replace(/[^\n]*$/, '')}\n${content}`;
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return {};
  }
  const turns = [];
  let firstPrompt;
  let customTitle;
  for (const line of content.split('\n')) {
    if (!line) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row?.sessionId !== sessionId) continue;
    if (row.type === 'user' && row.message?.role === 'user') {
      const text = messageText(row.message);
      firstPrompt ??= text;
      appendTurn(turns, 'user', text);
    } else if (row.type === 'assistant' && row.message?.role === 'model') {
      appendTurn(turns, 'assistant', messageText(row.message));
    } else if (row.type === 'system' && row.subtype === 'custom_title') {
      customTitle = cleanText(row.systemPayload?.customTitle, 160) ?? customTitle;
    }
  }
  return {
    title: customTitle ?? cleanText(firstPrompt, 160),
    firstPrompt,
    turns,
  };
}

function eventHooks(commandFor, nameFor) {
  return Object.fromEntries(EVENTS.map(event => {
    const group = {
      hooks: [{
        type: 'command',
        name: nameFor(event),
        command: commandFor(event),
        timeout: 5,
      }],
    };
    if (event === 'PreToolUse' || event === 'PermissionRequest' || event === 'PostToolUse') {
      group.matcher = '*';
    }
    return [event, [group]];
  }));
}

function settingsPath(home) {
  return path.join(home, '.qwen', 'settings.json');
}

function readSettings(file) {
  if (!fs.existsSync(file)) return {};
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new Error(`Qwen settings must be a JSON object: ${file}`);
  }
  if (value.hooks !== undefined && (!value.hooks || Array.isArray(value.hooks) || typeof value.hooks !== 'object')) {
    throw new Error(`Qwen hooks must be a JSON object: ${file}`);
  }
  return value;
}

function writeSettings(file, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text) return;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const mode = fs.statSync(file, { throwIfNoEntry: false })?.mode & 0o777 || 0o600;
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, text, { flag: 'wx', mode });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function externalName(event, ctx) {
  const runner = path.join(path.dirname(ctx.pluginDir), 'hook.cjs');
  const profile = createHash('sha256').update(runner).digest('hex').slice(0, 12);
  return `${OWNER}-${profile}-${event}`;
}

function ownedHook(hook, event, ctx) {
  if (hook?.name !== externalName(event, ctx) && hook?.name !== `${OWNER}-${event}`) return false;
  const runner = path.join(path.dirname(ctx.pluginDir), 'hook.cjs');
  if (typeof hook.command !== 'string' || !hook.command.includes(runner)) {
    if (hook.name === `${OWNER}-${event}`) return false;
    throw new Error(`Qwen hook name is already used by another command: ${hook.name}`);
  }
  return true;
}

function removeOwned(settings, ctx) {
  if (!settings.hooks) return false;
  let changed = false;
  for (const event of EVENTS) {
    const groups = settings.hooks[event];
    if (groups === undefined) continue;
    if (!Array.isArray(groups)) throw new Error(`Qwen hooks.${event} must be an array`);
    let eventChanged = false;
    const next = [];
    for (const group of groups) {
      if (!group || typeof group !== 'object' || !Array.isArray(group.hooks)) {
        next.push(group);
        continue;
      }
      const hooks = group.hooks.filter(hook => !ownedHook(hook, event, ctx));
      if (hooks.length !== group.hooks.length) eventChanged = true;
      if (hooks.length) next.push(hooks.length === group.hooks.length ? group : { ...group, hooks });
      else if (hooks.length === group.hooks.length) next.push(group);
    }
    if (next.length) settings.hooks[event] = next;
    else if (eventChanged) delete settings.hooks[event];
    changed ||= eventChanged;
  }
  if (changed && !Object.keys(settings.hooks).length) delete settings.hooks;
  return changed;
}

function installExternal(ctx) {
  const file = settingsPath(ctx.home);
  const settings = readSettings(file);
  removeOwned(settings, ctx);
  settings.hooks ??= {};
  for (const [event, entries] of Object.entries(eventHooks(
    event => ctx.hookCommand(event),
    event => externalName(event, ctx),
  ))) {
    const groups = settings.hooks[event] ?? [];
    if (!Array.isArray(groups)) throw new Error(`Qwen hooks.${event} must be an array`);
    settings.hooks[event] = [...groups, ...entries];
  }
  writeSettings(file, settings);
}

function uninstallExternal(ctx) {
  const file = settingsPath(ctx.home);
  if (!fs.existsSync(file)) return;
  const settings = readSettings(file);
  if (removeOwned(settings, ctx)) writeSettings(file, settings);
}

function installCard(ctx) {
  const file = path.join(ctx.pluginDir, 'card-hooks.json');
  const hooks = eventHooks(
    event => ctx.hookCommand(event),
    event => `que-qwen-code-card-${event}`,
  );
  writeSettings(file, { hooks });
}

function launchCommand(pluginDir, remote, extraArgs = []) {
  const script = remote
    ? path.posix.join(pluginDir, 'launch.sh')
    : path.join(pluginDir, 'launch.sh');
  return { command: 'sh', args: [script, ...extraArgs] };
}

export default function activate(que) {
  que.register({
    type: 'harness',
    apiVersion: 1,
    id: 'qwen-code',
    name: 'Qwen Code',
    description: 'Qwen Code CLI and external sessions',
    icon: 'qwen-color.svg',
    launch({ pluginDir, remote }) {
      return launchCommand(pluginDir, remote);
    },
    resume({ pluginDir, remote, sessionId }) {
      if (typeof sessionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(sessionId)) {
        throw new Error('Qwen Code requires a valid session id to resume');
      }
      return launchCommand(pluginDir, remote, ['--resume', sessionId]);
    },
    installHooks: installCard,
    externalHooks: { install: installExternal, uninstall: uninstallExternal },
    onHook({ event, input, scope }, ctx) {
      if ((scope !== 'card' && scope !== 'external') || !EVENTS.includes(event)) return;
      const signal = { event: event === 'SessionEnd' ? 'sessionEnd' : event };
      if (typeof input?.session_id === 'string'
          && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.session_id)) {
        signal.sessionId = input.session_id;
      }
      if (typeof input?.cwd === 'string' && input.cwd) signal.workspaceRoot = input.cwd;
      if (!signal.sessionId && !signal.workspaceRoot) return;
      if (event === 'SessionStart' || event === 'UserPromptSubmit' || event === 'Stop' || event === 'StopFailure') {
        const snapshot = readSessionSnapshot(input);
        const turns = snapshot.turns ?? [];
        // `prompt` can be a tool-result continuation. Only this field identifies
        // text that came from the user's composer before this hook ran.
        if (event === 'UserPromptSubmit') appendTurn(turns, 'user', input.submitted_prompt);
        if (event === 'Stop' || event === 'StopFailure') appendTurn(turns, 'assistant', input.last_assistant_message);
        signal.title = snapshot.title ?? cleanText(turns.find(turn => turn.role === 'user')?.text, 160);
        signal.firstPrompt = snapshot.firstPrompt;
        signal.prompt = event === 'UserPromptSubmit'
          ? cleanText(input.submitted_prompt)
          : [...turns].reverse().find(turn => turn.role === 'user')?.text;
        signal.turns = turns;
        if (event === 'Stop' || event === 'StopFailure') {
          signal.replyPreview = cleanText(input.last_assistant_message, 2000)
            ?? cleanText([...turns].reverse().find(turn => turn.role === 'assistant')?.text, 2000);
        }
      }
      if (typeof input?.tool_name === 'string') signal.tool = input.tool_name;
      if (typeof input?.agent_id === 'string') signal.agentId = input.agent_id;
      ctx.emit(signal);
    },
  });
}
