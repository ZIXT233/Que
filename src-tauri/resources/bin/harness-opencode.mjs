import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Lifecycle boundaries follow Orca's OpenCode status plugin; see docs/harness/hook-api.md.
export const QueState = async ({ client }) => {
  const sessions = new Map();
  const prompted = new Set();
  // OpenCode auto-titles sessions via the provider's small model. When that
  // never lands (custom providers, offline proxies) the title stays at the
  // "New session - <timestamp>" placeholder; treat it as absent so the card
  // falls back to the captured prompt.
  const DEFAULT_TITLE = /^(?:New session|Child session) - \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  let owner = process.env.QUE_HARNESS_SESSION_ID;
  let sequence = Promise.resolve();
  let lastSignalAt = 0;
  const enqueue = work => (sequence = sequence.then(work).catch(() => {}));

  const emit = (event, info, extra = {}) => {
    try {
      const title = typeof info.title === 'string' && !DEFAULT_TITLE.test(info.title)
        ? info.title.slice(0, 160)
        : undefined;
      const signal = {
        kind: 'opencode',
        at: (lastSignalAt = Math.max(Date.now(), lastSignalAt + 1)),
        event,
        sessionId: info.id,
        title,
        ...extra,
      };
      const token = process.env.QUE_HARNESS_CHANNEL;
      const extDir = path.join(process.env.HOME || process.env.USERPROFILE || '', '.que', 'external-signals');
      const dir = process.env.QUE_HARNESS_SIGNAL_DIR || extDir;
      if (token && process.platform !== 'win32') {
        try { fs.writeFileSync(
          process.env.QUE_HARNESS_TTY || '/dev/tty',
          `\x1b]777;que;${Buffer.from(JSON.stringify({ token, signal })).toString('base64')}\x07`,
        ); } catch { /* File delivery is independent of OSC delivery. */ }
      }
      if (process.env.QUE_HARNESS_SIGNAL_DIR || !token) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const file = path.join(dir, `${signal.at}-${randomUUID()}.json`);
        fs.writeFileSync(`${file}.tmp`, JSON.stringify(signal), { mode: 0o600 });
        fs.renameSync(`${file}.tmp`, file);
      }
    } catch { /* Observation cannot block the TUI. */ }
  };

  async function infoFor(id) {
    if (sessions.has(id)) return sessions.get(id);
    const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(1500) : undefined;
    // Orca supports both OpenCode SDK generations; retain that compatibility boundary.
    const calls = client?.session?.get?.length >= 2
      ? [[{ sessionID: id }, { signal }], [{ path: { id }, signal }]]
      : [[{ path: { id }, signal }], [{ sessionID: id }]];
    for (const args of calls) {
      if (signal?.aborted) break;
      try {
        const response = await client.session.get(...args);
        const data = response?.data ?? response;
        if (data?.id === id) {
          if (sessions.size >= 256) sessions.delete(sessions.keys().next().value);
          sessions.set(id, data);
          return data;
        }
      } catch { /* Fall through; status events must not depend on get(). */ }
    }
  }

  function isChild(info) {
    return !!(info?.parentID || info?.parentId || info?.parent_id);
  }

  async function resolve(id, hint) {
    if (hint?.id === id) {
      sessions.set(id, hint);
      return hint;
    }
    return (await infoFor(id)) || { id };
  }

  function previewText(value) {
    if (typeof value !== 'string') return undefined;
    const text = value.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
    return text ? text.slice(0, 160) : undefined;
  }

  function promptText(output) {
    const parts = output?.parts ?? output?.message?.parts ?? output?.message?.content;
    if (typeof parts === 'string') return previewText(parts);
    if (!Array.isArray(parts)) return undefined;
    const text = parts
      .map(part => (typeof part === 'string' ? part : part?.type === 'text' ? part.text : ''))
      .filter(Boolean)
      .join(' ');
    return previewText(text);
  }

  async function replyPreview(sessionId) {
    if (!client?.session?.messages) return undefined;
    const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(1500) : undefined;
    const attempts = [
      [{ path: { id: sessionId }, signal }],
      [{ sessionID: sessionId }, { signal }],
    ];
    for (const args of attempts) {
      try {
        const response = await client.session.messages(...args);
        const rows = response?.data ?? response;
        if (!Array.isArray(rows)) continue;
        for (let index = rows.length - 1; index >= 0; index--) {
          const row = rows[index];
          const info = row?.info ?? row;
          const role = info?.role ?? row?.role;
          if (role !== 'assistant') continue;
          const parts = row?.parts ?? info?.parts ?? info?.content;
          if (typeof parts === 'string') return previewText(parts);
          if (!Array.isArray(parts)) continue;
          const text = parts
            .map(part => (typeof part === 'string' ? part : part?.type === 'text' ? part.text : ''))
            .filter(Boolean)
            .join(' ');
          const preview = previewText(text);
          if (preview) return preview;
        }
      } catch { /* Preview is optional for completion notifications. */ }
    }
  }

  return {
    'chat.message': (input, output) => enqueue(async () => {
      const sessionID = input?.sessionID || input?.sessionId;
      if (!sessionID) return;
      const info = await resolve(sessionID);
      if (isChild(info)) return;
      owner = info.id;
      const prompt = promptText(output);
      const first = !!prompt && !prompted.has(info.id);
      if (prompt) {
        prompted.add(info.id);
        if (prompted.size >= 512) prompted.delete(prompted.keys().next().value);
      }
      emit('UserPromptSubmit', info, first ? { prompt, firstPrompt: prompt } : { prompt });
    }),
    event: ({ event }) => {
      // Serialize async identity lookups so older idle events cannot pass newer busy events.
      if (![
        'session.created', 'session.updated', 'session.status', 'session.idle',
        'permission.asked', 'question.asked', 'permission.replied', 'question.replied', 'question.rejected',
      ].includes(event.type)) return;
      return enqueue(async () => {
        const properties = event.properties || {};
        if (properties.info?.id && event.type.startsWith('session.')) sessions.set(properties.info.id, properties.info);
        const id = properties.sessionID || properties.sessionId || properties.info?.id;
        if (!id) return;
        const info = await resolve(id, properties.info);
        if (isChild(info)) return;
        const status = properties.status?.type ?? (typeof properties.status === 'string' ? properties.status : undefined);
        if (!owner || status === 'busy' || status === 'retry') owner = id;
        if (id !== owner) return;
        if (event.type === 'session.created') emit('SessionStart', info);
        else if (event.type === 'session.updated') emit('SessionInfo', info);
        else if (event.type === 'permission.asked' || event.type === 'question.asked') emit('PermissionRequest', info);
        else if (['permission.replied', 'question.replied', 'question.rejected'].includes(event.type)) emit('UserPromptSubmit', info);
        else if (status === 'busy' || status === 'retry') emit('UserPromptSubmit', info);
        else if (status === 'idle' || event.type === 'session.idle') {
          emit('Stop', info, { replyPreview: await replyPreview(id) });
        }
      });
    },
  };
};

export default QueState;
