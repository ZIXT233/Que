/* eslint-disable @typescript-eslint/no-require-imports -- Standalone passive CLI hook. */
// Shared ingress for built-in CLI adapters. Public contract: docs/harness/hook-api.md

// Opt-in lifecycle diagnostics: synchronous disk writes cost time on every hook.
const DEBUG_STARTED = process.hrtime.bigint();
const DEBUG_LOG = process.env.QUE_HOOK_DEBUG_FILE || require('path').join(__dirname, 'hook-debug.jsonl');
function dbg(stage, extra = {}) {
  if (process.env.QUE_HOOK_DEBUG !== '1') return;
  try {
    require('fs').appendFileSync(
      DEBUG_LOG,
      JSON.stringify({
        ts: new Date().toISOString(),
        elapsedMs: Number(process.hrtime.bigint() - DEBUG_STARTED) / 1e6,
        pid: process.pid,
        ppid: process.ppid,
        stage,
        cwd: process.cwd(),
        ...extra,
      }) + '\n'
    );
  } catch {}
}
dbg('process-start');
process.on('uncaughtException', err => {
  dbg('uncaught-exception', { message: err.message, stack: err.stack });
  process.exit(91);
});
process.on('unhandledRejection', err => {
  dbg('unhandled-rejection', { message: String(err), stack: err?.stack });
  process.exit(92);
});

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
// Ambient registrations pass --que-ambient so a wild CLI session launched inside
// a Que card terminal does not report into the card's own signal directory —
// the same early exit the unix external-hook.sh shim performs on Que env vars.
const ambientArg = process.argv[2] || '';
const ambientIngress = ambientArg === '--que-ambient' || ambientArg.startsWith('--que-ambient:');
const explicitEvent = ambientIngress
  ? (ambientArg.startsWith('--que-ambient:') ? ambientArg.slice('--que-ambient:'.length) : process.argv[3])
  : process.argv[2];
const commandMode = require.main === module;
const cursorEvents = new Set(['sessionStart', 'beforeSubmitPrompt', 'preToolUse', 'postToolUse', 'postToolUseFailure', 'beforeShellExecution', 'beforeMCPExecution', 'afterAgentResponse', 'stop', 'sessionEnd']);
function cursorReply(event) {
  if (event === 'beforeSubmitPrompt') return { continue: true };
  if (event === 'preToolUse' || event === 'beforeShellExecution' || event === 'beforeMCPExecution') return { permission: 'allow' };
  return {};
}
let inferredKind = undefined;
const parts = __dirname.split(path.sep);
const hpIdx = parts.lastIndexOf('harness-plugins');
if (hpIdx >= 0 && parts[hpIdx + 1]) {
  inferredKind = parts[hpIdx + 1];
}
const kind = process.env.QUE_HARNESS_KIND || inferredKind || (cursorEvents.has(explicitEvent) ? 'cursor' : undefined);
// Compatibility readers can invoke another CLI's registration. Grok's own
// registration is authoritative; imported copies must not create duplicate or
// mislabelled notices, even when QUE_HARNESS_KIND happens to say "grok".
if (commandMode && process.env.GROK_HOOK_EVENT && inferredKind && inferredKind !== 'grok') process.exit(0);
if (commandMode && process.env.CURSOR_VERSION && inferredKind === 'claude') process.exit(0);
let effectiveKind = kind;
const token = process.env.QUE_HARNESS_CHANNEL;
const envDirectory = process.env.QUE_HARNESS_SIGNAL_DIR;
if (commandMode && ambientIngress && (envDirectory || token)) process.exit(0);
const activePath = path.join(__dirname, 'active.json');
// User-level hooks fire for IDE chats, external terminals, etc., which inherit neither
// SIGNAL_DIR nor CHANNEL. Those sessions are not queue cards, so their events go to the
// external notification sink instead of being dropped — the queue surfaces them as a
// transient, never-persisted notice.
// Cursor observe hooks ignore stdout, but answering before stdin is fully read
// lets the worker tear the process down before replyPreview is written. Reply
// after the signal (beforeSubmitPrompt still returns continue:true).
if (commandMode && (kind === 'gemini' || kind === 'grok')) process.stdout.write('{}\n');
const knownHarnesses = new Set(['cursor', 'codex', 'antigravity', 'gemini', 'grok', 'claude', 'opencode', 'codebuddy', 'pi', 'omp', 'devin']);
if (commandMode && !envDirectory && !token && !legacyActiveDirectory() && (!kind || !knownHarnesses.has(kind))) {
  process.exit(0);
}
let input = '', oversized = false, done = false, finished = false;
// CLI hook runners kill us on their own deadline (codex 5s, cursor 15s). Fire
// before theirs so a hung stdin still delivers the signal instead of dying
// with a "hook timed out" and losing the event.
const watchdog = Math.max(500, Number(process.env.QUE_HARNESS_WATCHDOG_MS) || 8000);
const timer = commandMode ? setTimeout(() => { dbg('watchdog-fired'); consume(); finish(); }, watchdog) : undefined;
function finish() {
  if (finished) return;
  finished = true;
  dbg('finish', { consumed: done });
  clearTimeout(timer);
  if (effectiveKind === 'cursor') process.stdout.write(JSON.stringify(cursorReply(explicitEvent)) + '\n');
  process.exit(0);
}
if (commandMode) {
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  dbg('stdin-data', { bytes: Buffer.byteLength(chunk) });
  if (input.length + chunk.length > 1024 * 1024) { oversized = true; input = ''; finish(); return; }
  input += chunk;
  consume();
});
process.stdin.on('error', () => { dbg('stdin-error'); finish(); });
process.stdin.on('end', () => { dbg('stdin-end'); consume(); finish(); });
process.on('exit', code => { dbg('process-exit', { code }); });
}

function readActive() {
  try { return JSON.parse(fs.readFileSync(activePath, 'utf8')); }
  catch { return undefined; }
}

function legacyActiveDirectory() {
  const active = readActive();
  return typeof active?.directory === 'string' && active.directory ? active.directory : undefined;
}

// Where a session Que never launched parks its events. The plugin lives at
// <data>/harness-plugins/<kind>/hook.cjs, so the data root is the parent of the
// plugin root; the bin/ copy used by dev and tests falls back to the default
// install location.
function externalDirectory() {
  if (process.env.QUE_EXTERNAL_SIGNAL_DIR) return process.env.QUE_EXTERNAL_SIGNAL_DIR;
  const marker = `${path.sep}harness-plugins${path.sep}`;
  const index = __dirname.lastIndexOf(marker);
  if (index > 0) return path.join(__dirname.slice(0, index), 'external-signals');
  return path.join(os.homedir(), '.que', 'external-signals');
}

// External sinks have no reader while Que is closed, so drop stale files here.
function pruneExternal(directory) {
  try {
    const cutoff = Date.now() - 5 * 60 * 1000;
    for (const name of fs.readdirSync(directory)) {
      if (!/^\d+-[a-f0-9-]+\.json$/.test(name)) continue;
      const target = path.join(directory, name);
      try { if (fs.statSync(target).mtimeMs < cutoff) fs.unlinkSync(target); } catch { /* Best effort. */ }
    }
  } catch { /* The sink is optional. */ }
}

function workspaceRootOf(payload) {
  // Devin payloads carry no cwd; the hook process gets DEVIN_PROJECT_DIR instead.
  const roots = payload.workspace_roots ?? payload.workspaceRoots ?? payload.workspace_root ?? payload.cwd ?? process.env.DEVIN_PROJECT_DIR;
  const value = Array.isArray(roots) ? roots[0] : roots;
  return typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 512) || undefined : undefined;
}

function replyText(payload) {
  return payload.text ?? payload.last_assistant_message ?? payload.lastAssistantMessage
    ?? payload.prompt_response ?? payload.response ?? payload.message ?? payload.content;
}

function consume() {
  if (done || oversized) return;
  let payload;
  try { payload = JSON.parse(input.replace(/^\uFEFF/, '')); }
  catch { return; }
  done = true;
  dbg('payload-ready', { event: explicitEvent || payload.hook_event_name || payload.hookEventName });
  try { deliver(payload); } finally { finish(); }
}

// Persistent transports share the same event normalization and sinks, without
// stdin ownership, watchdogs, process exit, or a child process per notification.
module.exports = { deliver };
function deliver(payload) {
  const at = Date.now();
  const externalPath = !envDirectory && !token ? externalDirectory() : undefined;
  try {
    let eventName = explicitEvent || payload.hook_event_name || ({session_start:"SessionStart",user_prompt_submit:"UserPromptSubmit",pre_tool_use:"PreToolUse",post_tool_use:"PostToolUse",post_tool_use_failure:"PostToolUseFailure",stop_cancelled:"StopCancelled",stop:"Stop",stop_failure:"StopFailure",notification:"Notification"})[payload.hookEventName];
    // The ingress maps names, it never renames an event into a different meaning: a
    // harness's own vocabulary is passed through and the state machine reads it. A fact
    // the contract has no name for (agy's "this Stop is not a turn end") travels as a
    // field, so a reader can always see what was really reported.
    const fullyIdle = payload.fullyIdle ?? payload.fully_idle;
    const isCursorEnv = Boolean(
      process.env.CURSOR_AGENT ||
      process.env.CURSOR_CHANNEL ||
      process.env.CURSOR_INVOKED_AS ||
      process.env.CURSOR_VERSION ||
      process.env.CURSOR_PROJECT_DIR ||
      process.env.CURSOR_TRACE_ID
    );
    const isCursorPayload = Boolean(payload.conversationId || payload.conversation_id) && !payload.transcript_path && !payload.hook_event_name;
    if ((kind === 'claude' || kind === 'codebuddy') && (isCursorEnv || isCursorPayload)) {
      effectiveKind = 'cursor';
    }
    const text = value => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 160) : undefined;
    const directory = envDirectory || externalPath || (effectiveKind === 'cursor' ? undefined : legacyActiveDirectory());
    const external = externalPath !== undefined && directory === externalPath;
    // A card preview only has to hint at the reply; an external notice is the only
    // place that reply will ever be read, so keep its line breaks and its length.
    const externalReply = value => typeof value === 'string'
      ? value.replace(/\r\n?/g, '\n').replace(/[^\S\n]+/g, ' ').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trim().slice(0, 2000)
      : undefined;
    const externalPrompt = value => typeof value === 'string'
      ? value.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trim().slice(0, 16000)
      : undefined;
    const completion = eventName === 'afterAgentResponse' || ['Stop', 'stop', 'AfterAgent'].includes(eventName);
    const event = { kind: effectiveKind, at, event: eventName, fullyIdle: typeof fullyIdle === 'boolean' ? fullyIdle : undefined, replyPreview: completion ? (external ? externalReply(replyText(payload)) : text(replyText(payload))) : undefined, sessionId: payload.conversationId || payload.conversation_id || payload.session_id || payload.sessionId,
      agentId: payload.agent_id || payload.agentId, tool: payload.toolCall?.name ?? payload.tool_name ?? payload.toolName ?? payload.name,
      notification: payload.notification_type ?? payload.notificationType ?? payload.type,
      prompt: ['UserPromptSubmit', 'beforeSubmitPrompt', 'BeforeAgent'].includes(eventName)
        ? (external ? externalPrompt(payload.prompt) : text(payload.prompt)) : undefined };
    if (external) { event.workspaceRoot = workspaceRootOf(payload); event.external = true; }
    const debug = process.env.QUE_HARNESS_DEBUG === '1';
    // Keep only field metadata, never prompt/reply text, to diagnose missing previews.
    if (debug && kind === 'codex' && directory && eventName === 'Stop') {
      try {
        const value = payload.last_assistant_message;
        const diagnostic = { at, event: eventName, sessionId: event.sessionId,
          replyFieldPresent: Object.hasOwn(payload, 'last_assistant_message'),
          replyFieldType: value === null ? 'null' : typeof value,
          replyLength: typeof value === 'string' ? value.length : 0,
          previewLength: event.replyPreview?.length ?? 0 };
        const target = path.join(directory, 'last-stop-diagnostic.json');
        const temporary = `${target}.${randomUUID()}.tmp`;
        fs.writeFileSync(temporary, JSON.stringify(diagnostic), { mode: 0o600 });
        fs.renameSync(temporary, target);
      } catch {}
    }
    let channel = token;
    // Reattaching a persistent tmux pane creates a new local reader, but the
    // running CLI keeps its old environment. Resolve the current channel from
    // this Que session instead of silently sending every hook to the old one.
    if (token && process.env.TMUX && process.env.QUE_HARNESS_TMUX_SESSION) {
      try {
        const value = execFileSync('tmux', ['show-environment', '-t', `=${process.env.QUE_HARNESS_TMUX_SESSION}`, 'QUE_HARNESS_CHANNEL'], {
          encoding: 'utf8', timeout: 500, maxBuffer: 4096, stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();
        const current = value.match(/^QUE_HARNESS_CHANNEL=([A-Za-z0-9_-]{1,128})$/);
        if (current) channel = current[1];
      } catch (error) {
        dbg('tmux-channel-unavailable', { message: error instanceof Error ? error.message : String(error) });
      }
    }
    const delivered = { osc: false, file: false, oscError: undefined, fileError: undefined };
    if (channel) {
      try {
        const signal = Buffer.from(JSON.stringify({ token: channel, signal: event })).toString('base64');
        const osc = `\x1b]777;que;${signal}\x07`;
        // tmux consumes unrecognized OSC instead of forwarding it. Its DCS
        // passthrough envelope doubles each ESC and delivers the original OSC
        // to Que outside the multiplexer.
        const frame = process.env.TMUX ? `\x1bPtmux;${osc.replace(/\x1b/g, '\x1b\x1b')}\x1b\\` : osc;
        fs.writeFileSync(process.env.QUE_HARNESS_TTY || '/dev/tty', frame);
        delivered.osc = true;
      } catch (error) {
        delivered.oscError = error instanceof Error ? error.message : String(error);
      }
    }
    if (directory) {
      try {
        // Card sinks are pre-created by the app; the external sink has no owner yet.
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        const target = path.join(directory, `${at}-${randomUUID()}.json`);
        fs.writeFileSync(`${target}.tmp`, JSON.stringify(event), { mode: 0o600 });
        fs.renameSync(`${target}.tmp`, target);
        delivered.file = true;
      } catch (error) {
        delivered.fileError = error instanceof Error ? error.message : String(error);
      }
      if (debug) {
        try {
          fs.appendFileSync(path.join(directory, 'hook-trace.jsonl'), `${JSON.stringify({ at, event: eventName, sessionId: event.sessionId, ...delivered })}\n`);
        } catch { /* Trace must not block the CLI. */ }
      }
      if (external) pruneExternal(directory);
    }
    dbg('signal-delivered', { event: eventName, ...delivered });
  } catch { /* Observation cannot block the CLI or emit model-visible text. */ }
}
