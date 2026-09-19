import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

// V2 CLI entrypoint: the shared server does not own this terminal's environment.
// Plugin.define is an identity helper; no package install is needed for this object.
export default {
  id: 'que.opencode.status',
  setup(ctx) {
    const external = !process.env.QUE_HARNESS_SIGNAL_DIR && !process.env.QUE_HARNESS_CHANNEL;
    const enabled = () => !ctx.options?.queExternalEnabledFile || fs.existsSync(ctx.options.queExternalEnabledFile);
    let owner;
    const snapshots = new Map();
    let lastAt = 0;
    const preview = value => typeof value === 'string'
      ? value.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 160) || undefined : undefined;
    const emit = (event, info, extra = {}) => {
      if (!enabled()) return;
      const signal = { kind: 'opencode', event, sessionId: info.id,
        external,
        workspaceRoot: info.directory || ctx.location?.directory || ctx.data.location.default()?.directory || process.cwd(),
        title: /^New session|^Child session/.test(info.title || '') ? undefined : preview(info.title),
        at: (lastAt = Math.max(Date.now(), lastAt + 1)), ...extra };
      let token = process.env.QUE_HARNESS_CHANNEL;
      if (token && process.env.TMUX && process.env.QUE_HARNESS_TMUX_SESSION) {
        try {
          const value = execFileSync('tmux', ['show-environment', '-t', `=${process.env.QUE_HARNESS_TMUX_SESSION}`, 'QUE_HARNESS_CHANNEL'],
            { encoding: 'utf8', timeout: 500, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
          token = value.match(/^QUE_HARNESS_CHANNEL=([A-Za-z0-9_-]{1,128})$/)?.[1] || token;
        } catch { /* Keep the launch channel when tmux cannot answer. */ }
      }
      if (token && process.platform !== 'win32') {
        try {
          const osc = `\x1b]777;que;${Buffer.from(JSON.stringify({ token, signal })).toString('base64')}\x07`;
          const frame = process.env.TMUX ? `\x1bPtmux;${osc.replace(/\x1b/g, '\x1b\x1b')}\x1b\\` : osc;
          fs.writeFileSync(process.env.QUE_HARNESS_TTY || '/dev/tty', frame);
        } catch { /* Local file delivery below is independent of terminal delivery. */ }
      }
      const dir = process.env.QUE_HARNESS_SIGNAL_DIR || (!token
        ? ctx.options?.queExternalSignalDir || process.env.QUE_EXTERNAL_SIGNAL_DIR
          || path.join(process.env.HOME || process.env.USERPROFILE || '', '.que', 'external-signals') : undefined);
      if (dir) {
        try {
          fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
          const file = path.join(dir, `${signal.at}-${randomUUID()}.json`);
          fs.writeFileSync(`${file}.tmp`, JSON.stringify(signal), { mode: 0o600 });
          fs.renameSync(`${file}.tmp`, file);
        } catch (error) { console.error('[que.status] signal delivery failed', error.message); }
      }
    };
    const selected = () => {
      const route = ctx.ui.router.current();
      if (route.type !== 'session') return;
      // Do not attach a subagent or another CLI's events to this card.
      const info = ctx.data.session.get(route.sessionID);
      return info && !info.parentID ? info : undefined;
    };
    const snapshot = (info) => {
      if (!info) return;
      if (!external && owner !== info.id) {
        owner = info.id;
        snapshots.delete(info.id);
        emit('SessionStart', info);
      }
      const messages = ctx.data.session.message.list(info.id) || [];
      const user = [...messages].reverse().find(message => message.type === 'user');
      const assistant = [...messages].reverse().find(message => message.type === 'assistant');
      const prompt = preview(user?.text);
      const replyPreview = preview(assistant?.content?.filter(part => part.type === 'text').map(part => part.text).join(' '));
      const waiting = (ctx.data.session.permission.list(info.id) || []).length > 0
        || (ctx.data.session.form.list(info.id, ctx.location) || []).length > 0;
      const state = waiting ? 'PermissionRequest' : ctx.data.session.status(info.id) === 'running' ? 'UserPromptSubmit' : 'Stop';
      const key = JSON.stringify([info.id, info.title, state, user?.id, prompt]);
      const previous = snapshots.get(info.id);
      if (key === previous?.key) return;
      snapshots.set(info.id, { key, state });
      // Merely opening an idle external chat must not create a completion alert.
      if (external && state === 'Stop' && (!previous || previous.state === 'Stop')) return;
      emit(state, info, { prompt, replyPreview, firstPrompt: preview(messages.find(message => message.type === 'user')?.text) });
    };
    const safelySnapshot = () => {
      try {
        if (!enabled()) { snapshots.clear(); return; }
        if (!external) { snapshot(selected()); return; }
        // Only tabs owned by this CLI, never every session on the shared server.
        const ids = new Set(ctx.ui.tabs.list().map(tab => tab.sessionID));
        const active = selected();
        if (active) ids.add(active.id);
        for (const id of snapshots.keys()) if (!ids.has(id)) snapshots.delete(id);
        for (const id of ids) {
          const info = ctx.data.session.get(id);
          if (info && !info.parentID) snapshot(info);
        }
      } catch (error) { console.error('[que.status] snapshot failed', error.message); }
    };
    // Cache events are delivered before every derived store is updated. Defer reads.
    let pending = false;
    let alive = true;
    const stop = ctx.data.listen(() => {
      if (pending) return;
      pending = true;
      queueMicrotask(() => { pending = false; if (alive) safelySnapshot(); });
    });
    // Route selection is client-local and does not necessarily produce a server event.
    const timer = setInterval(safelySnapshot, 250);
    safelySnapshot();
    return () => { alive = false; clearInterval(timer); stop(); };
  },
};
