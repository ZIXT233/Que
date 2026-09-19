import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Passive observer for per-card and auto-discovered external Pi/OMP sessions.
export default function queState(pi, options = {}) {
  const kind = process.env.QUE_HARNESS_KIND || options.kind || 'pi';
  function emit(event, ctx, prompt, tool) {
    try {
      if (options.enabledFile && !fs.existsSync(options.enabledFile)) return;
      const text = value => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 160) : undefined;
      const messages = event === 'Stop' ? ctx.sessionManager.buildSessionContext().messages : [];
      const last = [...messages].reverse().find(message => message.role === 'assistant');
      const replyPreview = last ? text(typeof last.content === 'string' ? last.content : last.content.filter(block => block.type === 'text').map(block => block.text).join(' ')) : undefined;
      const external = !process.env.QUE_HARNESS_SIGNAL_DIR && !process.env.QUE_HARNESS_CHANNEL;
      const signal = { kind, replyPreview, at: Date.now(), event, sessionId: ctx.sessionManager.getSessionId(), title: text(ctx.sessionManager.getSessionName()), prompt: text(prompt), tool, ...(external ? { external: true, workspaceRoot: ctx.cwd || process.cwd() } : {}) };
      const token = process.env.QUE_HARNESS_CHANNEL;
      const extDir = options.signalDir || process.env.QUE_EXTERNAL_SIGNAL_DIR || path.join(process.env.HOME || process.env.USERPROFILE || '', '.que', 'external-signals');
      const dir = process.env.QUE_HARNESS_SIGNAL_DIR || extDir;
      if (token) {
        fs.writeFileSync('/dev/tty', `\x1b]777;que;${Buffer.from(JSON.stringify({ token, signal })).toString('base64')}\x07`);
      } else if (dir) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const target = path.join(dir, `${signal.at}-${randomUUID()}.json`);
        fs.writeFileSync(`${target}.tmp`, JSON.stringify(signal), { mode: 0o600 });
        fs.renameSync(`${target}.tmp`, target);
      }
    } catch { /* A status observer must not interrupt Pi. */ }
  }
  let working = false;
  let settleTimer = null;
  const cancelSettle = () => { if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; } };
  const settle = (ctx) => { cancelSettle(); if (!working) return; working = false; emit('Stop', ctx); };
  pi.on('session_start', (_event, ctx) => emit('SessionStart', ctx));
  pi.on('session_info_changed', (_event, ctx) => emit('SessionInfo', ctx));
  pi.on('before_agent_start', (event, ctx) => { cancelSettle(); working = true; emit('UserPromptSubmit', ctx, event.prompt); });
  pi.on('agent_start', (_event, ctx) => { cancelSettle(); if (!working) emit('UserPromptSubmit', ctx); working = true; });
  // OMP 18.x dropped agent_settled — its end-of-run event is agent_end. Upstream pi
  // still fires agent_settled, where agent_end alone can precede retries/compaction,
  // so there agent_end only arms a short fallback that agent_settled short-circuits.
  if (kind === 'omp') {
    pi.on('agent_end', (event, ctx) => { if (event.isTerminal !== false) settle(ctx); });
    // OMP has no ui_prompt_start/end observer. An ask tool attempt is tentative:
    // the backend holds it briefly and tool_result cancels it on validation failure.
    pi.on('tool_call', (event, ctx) => {
      if (event.toolName === 'ask') emit('PreToolUse', ctx, undefined, 'ask');
    });
    pi.on('tool_result', (event, ctx) => {
      if (event.toolName === 'ask') emit('PostToolUse', ctx, undefined, 'ask');
    });
  } else {
    pi.on('agent_end', (_event, ctx) => {
      cancelSettle();
      settleTimer = setTimeout(() => { settleTimer = null; settle(ctx); }, 2500);
    });
    pi.on('agent_settled', (_event, ctx) => settle(ctx));
  }
  if (kind !== 'omp') {
    pi.on('ui_prompt_start', (_event, ctx) => emit('PermissionRequest', ctx));
    pi.on('ui_prompt_end', (_event, ctx) => emit(working ? 'UserPromptSubmit' : 'Stop', ctx));
  }
}
