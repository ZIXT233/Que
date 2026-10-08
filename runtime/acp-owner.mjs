// Que's ACP owner: a thin layer over acpx.
//
//   a workspace's agent environment  = one AcpRuntime
//   a card                           = one acpx session, sessionKey = card id
//   a card's conversation            = that session's acpx record
//
// On top of acpx it keeps only what Que needs: the turns submitted in this run
// (streamed to Que as snapshot + delta, see session-wire.mjs), the decisions
// waiting for a person, and the card state derived from those.
//
// Lifetime. On this machine the owner is Que's child over stdin/stdout and
// ends with Que. On a remote host it runs with --serve inside tmux and outlives
// SSH; Que reaches it with --connect (see resources/remote-owner.sh).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { createAcpRuntime, createAgentRegistry, createFileSessionStore } from 'acpx/runtime';
import { remoteMcpHub } from './remote-mcp.mjs';
import { createSessionWire } from './session-wire.mjs';
import { sessionHistory, projectRecord, messageHeader } from './session-history.mjs';
import { sessionErrorMessage } from './errors.mjs';
import { discoverSessions } from './native-sessions.mjs';
import { sessionEnvironment } from './session-environment.mjs';
import { agentReaper } from './agent-reaper.mjs';
import { missingAgentCommand, agentAvailability } from './preflight.mjs';
import { relay } from './relay.mjs';

if (Number(process.versions.node.split('.')[0]) < 22) throw Error('Flat requires Node.js 22.13 or newer');
const root = process.env.FLAT_ACP_ROOT || path.join(os.homedir(), '.flat', 'acp');
fs.mkdirSync(root, { recursive: true, mode: 0o700 });
const ownerSocket = path.join(root, 'owner.sock');
const build = createHash('sha256').update(fs.readFileSync(fileURLToPath(import.meta.url))).digest('hex');
const serveMode = process.argv.includes('--serve');
if (process.argv.includes('--connect')) await relay({ socketPath: ownerSocket, build, wait: process.argv.includes('--wait') });

// One owner per data directory; wait for a previous one that is still stopping its agents.
const pidFile = path.join(root, 'owner.pid');
async function acquireOwnership() {
  for (let i = 0; i < 200; i++) {
    try { const fd = fs.openSync(pidFile, 'wx', 0o600); fs.writeSync(fd, String(process.pid)); fs.closeSync(fd); return; }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
    let pid; try { pid = Number(fs.readFileSync(pidFile, 'utf8')); } catch { continue; }
    try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') { try { fs.unlinkSync(pidFile); } catch {} continue; } }
    await new Promise(r => setTimeout(r, 50));
  }
  throw Error('另一个 Que 正在使用会话数据，请先退出它');
}
await acquireOwnership();
const reaper = agentReaper(path.join(root, 'agent-pids.json'));
reaper.reapStale();

const storeDir = process.env.FLAT_ACP_STORE_DIR || path.join(os.homedir(), '.acpx');
const files = createFileSessionStore({ stateDir: storeDir });
/** Agents change mode or options mid-turn; their status is re-read once acpx has saved it. */
const statusDirty = new Set();
// acpx persists through this store; watching saves keeps title and status
// current without reading the record again or changing what acpx writes.
const store = {
  load: key => files.load(key),
  async save(record) {
    await files.save(record);
    const s = sessions[record.acpxRecordId];
    if (!s) return;
    s.title = record.title || s.title;
    s.promptCapabilities = record.agentCapabilities?.promptCapabilities || s.promptCapabilities;
    publish(s.id);
    if (statusDirty.delete(s.id)) setImmediate(() => void metadata(s.id).catch(() => {}));
  },
};
const listHistory = sessionHistory(storeDir, store);
const customAgents = path.join(root, 'agents.json');
const registry = createAgentRegistry({ overrides: fs.existsSync(customAgents) ? JSON.parse(fs.readFileSync(customAgents, 'utf8')) : {} });
const mcpSocketPath = process.platform === 'win32' ? `\\\\.\\pipe\\flat-mcp-${createHash('sha256').update(root).digest('hex').slice(0, 20)}` : path.join(root, 'mcp.sock');
const remoteBridgePath = path.join(root, 'remote-mcp.cjs');

/** What clients see, one per card: the acpx record plus turns submitted in this run. */
const sessions = {};
/** acpx state per card: runtime, session handle, admitted turns, open decisions. */
const live = new Map();
/** One acpx runtime per agent environment (a workspace's directory, variables and rc script). */
const runtimes = new Map();
const clients = new Set();
const mcpHub = remoteMcpHub({ socketPath: mcpSocketPath, sessions: () => sessions });
const wire = createSessionWire({ sessions: () => sessions, clients, epoch: randomUUID() });
let stopping = false;

const publish = (id, immediate = false, ops) => wire.publish(id, { immediate, ops });

/** A card's state follows from what acpx is doing for it. */
function settle(id) {
  const s = sessions[id], l = live.get(id);
  s.state = s.error ? 'error'
    : l?.starting ? 'starting'
    : l?.pending.size ? 'attention'
    : l?.turns.size ? 'working'
    : l?.handle && !l.disconnected ? 'attention'
    : 'not_running';
}

const normalize = command => Array.isArray(command) ? command : String(command ?? '').trim().split(/\s+/);
/** The registry agent a record was started with, when its command still matches one. */
function agentOf(record) {
  const argv = JSON.stringify(normalize(record.agentArgv?.length ? record.agentArgv : record.agentCommand));
  return registry.list().find(name => JSON.stringify(normalize(registry.resolve(name))) === argv);
}

/** A card not seen in this run is whatever its acpx record says. */
async function loadCard(id) {
  const record = await store.load(id);
  if (!record) return undefined;
  return { id, cwd: record.cwd, agent: agentOf(record), hostAccess: true, recordId: id, title: record.title,
    promptCapabilities: record.agentCapabilities?.promptCapabilities || {}, state: 'not_running', turns: projectRecord(record) };
}

function mcpServers(id) {
  const s = sessions[id];
  if (s?.mcpRelay) return [{ name: 'flat', command: process.execPath, args: [remoteBridgePath], env: [{ name: 'FLAT_MCP_SOCKET', value: mcpSocketPath }, { name: 'FLAT_MCP_CAPABILITY', value: mcpHub.capability(id, s.connectionId) }] }];
  if (s?.mcpBridge) return [{ name: 'flat', command: process.execPath, args: [s.mcpBridge], env: [{ name: 'FLAT_SOURCE_CARD', value: id }, { name: 'FLAT_SOURCE_EPOCH', value: s.connectionId }] }];
  return [];
}

const cardOf = process => process.scope?.kind === 'runtime-session' && sessions[process.scope.sessionKey] ? process.scope.sessionKey : undefined;
const stage = (process, value) => { const id = cardOf(process); if (id) { sessions[id].stage = value; publish(id); } };
const lifecycle = {
  onBeforeSpawn: launch => stage(launch, 'spawning'),
  onSpawned(started) {
    reaper.add(started.pid);
    const l = live.get(cardOf(started));
    if (l) { l.pid = started.pid; l.disconnected = false; }
    stage(started, 'connecting');
  },
  onSpawnFailed: failure => stage(failure, 'failed'),
  onExit(exit) {
    reaper.remove(exit.pid);
    const id = cardOf(exit), l = live.get(id);
    if (!l || l.pid !== exit.pid) return;
    // Losing the process proves a lost connection, not the outcome of a turn.
    l.disconnected = true; settle(id); publish(id, true);
  },
};

function runtimeFor(cwd, env, terminalRc = '') {
  const key = JSON.stringify([cwd, env, terminalRc]);
  if (!runtimes.has(key)) {
    const pending = (async () => {
      const agentProcessEnv = await sessionEnvironment({ root, cwd, env, terminalRc });
      const runtime = createAcpRuntime({ cwd, agentProcessEnv, sessionStore: store, agentRegistry: registry,
        mcpServers: ({ sessionKey }) => mcpServers(sessionKey),
        sessionPermissions: ({ sessionKey }) => ({ permissionMode: sessions[sessionKey]?.hostAccess === false ? 'deny-all' : 'approve-all' }),
        permissionMode: 'approve-all', nonInteractivePermissions: 'deny', elicitationModes: ['form'], processLifecycle: lifecycle });
      return { runtime, agentProcessEnv };
    })();
    runtimes.set(key, pending);
    pending.catch(() => runtimes.delete(key));
  }
  return runtimes.get(key);
}

async function metadata(id) {
  const l = live.get(id);
  if (!l?.handle) return;
  // Read first, then change and publish together: a reader must never see new
  // content under an old revision.
  const status = await l.runtime.getStatus({ handle: l.handle });
  const capabilities = await l.runtime.getCapabilities({ handle: l.handle });
  Object.assign(sessions[id], { status, capabilities });
  publish(id);
}

async function ensure(req) {
  const { id, cwd, agent } = req;
  if (!id || !cwd || !agent) throw Error('Invalid session target');
  // Que's card names the agent; acpx decides how to launch it. A record whose
  // command no longer matches (an adapter update) still belongs to this agent.
  const s = sessions[id] ??= await loadCard(id) ?? { id, cwd, hostAccess: true, turns: [] };
  if ((s.agent && s.agent !== agent) || s.cwd !== cwd) throw Error('这张卡片已绑定另一个 Agent 或目录');
  if (!registry.list().includes(agent)) throw Error(`未知的 Agent：${agent}`);
  s.agent = agent;
  if (typeof req.hostAccess === 'boolean') s.hostAccess = req.hostAccess;
  const current = live.get(id);
  if (current?.starting) return current.starting;
  if (current?.handle && !current.disconnected) return s;
  if (current?.turns.size) throw Error('会话正在结束上一轮，请稍后重试');
  const l = { turns: new Map(), pending: new Map() };
  live.set(id, l);
  s.mcpBridge = req.mcpBridge || s.mcpBridge;
  s.mcpRelay = req.mcpRelay === true || s.mcpRelay;
  s.connectionId = randomUUID();
  delete s.error; s.stage = 'preparing';
  l.starting = (async () => {
    try {
      const { runtime, agentProcessEnv } = await runtimeFor(cwd, req.env || {}, req.terminalRc);
      const missing = missingAgentCommand(registry, agent, agentProcessEnv);
      if (missing) throw Error(missing);
      // npx-launched adapters download on first use; say so instead of looking stuck.
      if (normalize(registry.resolve(agent))[0] === 'npx') { s.stage = 'installing'; publish(id); }
      l.runtime = runtime;
      // An empty conversation is not restored: there is nothing in it to keep.
      const saved = await store.load(id);
      if (saved && !saved.messages?.some(m => m.User)) {
        const empty = await runtime.findSession({ sessionKey: id, agent });
        if (empty) await runtime.prepareFreshSession({ handle: empty });
      }
      l.handle = await runtime.ensureSession({ sessionKey: id, agent, cwd, mode: 'persistent', resumeSessionId: s.resumeSessionId });
      delete s.resumeSessionId;
      s.recordId = l.handle.acpxRecordId ?? id;
      const record = await store.load(id);
      s.title = record?.title; s.promptCapabilities = record?.agentCapabilities?.promptCapabilities || {};
      // Turns submitted in this run already show their full live content.
      if (!s.turns.some(t => t.state !== 'history')) s.turns = projectRecord(record);
      await metadata(id).catch(() => {});
      return s;
    } catch (e) {
      s.error = sessionErrorMessage(e);
      if (live.get(id) === l) live.delete(id);
      throw e;
    } finally {
      l.starting = undefined; s.stage = undefined; settle(id); publish(id, true);
    }
  })();
  settle(id); publish(id, true);
  return l.starting;
}

// Fold one agent event into the turn and return the delta ops describing it.
// Values are copied: a later event may still mutate the block before the ops are sent.
const plain = value => JSON.parse(JSON.stringify(value));
function reduce(turn, event) {
  const set = (index, block) => ({ op: 'block', turn: turn.id, block: index, value: plain(block) });
  if (event.type === 'text_delta') {
    const index = turn.blocks.length - 1, last = turn.blocks[index];
    if (last?.type === 'text_delta' && last.stream === event.stream) {
      last.text += event.text;
      return [{ op: 'append', turn: turn.id, block: index, text: event.text }];
    }
    turn.blocks.push({ ...event });
    return [set(turn.blocks.length - 1, turn.blocks.at(-1))];
  }
  if (event.type === 'tool_call') {
    const index = event.toolCallId ? turn.blocks.findIndex(b => b.type === 'tool_call' && b.toolCallId === event.toolCallId) : -1;
    if (index >= 0) {
      const prior = turn.blocks[index];
      const patch = Object.fromEntries(Object.entries(event).filter(([, v]) => v !== undefined));
      if (patch.title === 'tool call' && prior.title) delete patch.title;
      Object.assign(prior, patch);
      return [set(index, prior)];
    }
    turn.blocks.push({ ...event });
    return [set(turn.blocks.length - 1, turn.blocks.at(-1))];
  }
  if (event.tag === 'plan') {
    const index = turn.blocks.findIndex(b => b.tag === 'plan');
    if (index >= 0) { Object.assign(turn.blocks[index], event); return [set(index, turn.blocks[index])]; }
    turn.blocks.push(event);
    return [set(turn.blocks.length - 1, event)];
  }
  return [];
}

/** A permission or form request waits in the turn until a person answers it. */
function ask(id, turn, kind, request, signal) {
  const l = live.get(id);
  return new Promise(resolve => {
    const key = randomUUID();
    const block = { type: 'decision', id: key, kind, request, state: 'pending' };
    const answer = value => {
      if (!l.pending.delete(key)) return;
      signal.removeEventListener('abort', abort);
      block.state = 'answered'; block.answer = value;
      settle(id); publish(id, true); resolve(value);
    };
    const abort = () => answer(kind === 'permission' ? { outcome: 'cancel' } : { action: 'cancel' });
    l.pending.set(key, { answer, block });
    turn.blocks.push(block); settle(id); publish(id, true);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

function checkAttachments(s, attachments) {
  if (attachments.length > 4) throw Error('最多添加 4 个附件');
  for (const a of attachments) {
    if (a.mediaType === 'text/plain') {
      if (typeof a.data !== 'string' || Buffer.byteLength(a.data, 'utf8') > 1024 * 1024 || a.data.includes('\0') || typeof a.name !== 'string' || a.name.length > 1024) throw Error('Invalid text file');
      continue;
    }
    const kind = a.mediaType?.split('/')[0];
    if (!['image', 'audio'].includes(kind) || !s.promptCapabilities?.[kind]) throw Error('当前 Agent 未声明支持该附件类型');
    if (typeof a.data !== 'string' || a.data.length > 12 * 1024 * 1024) throw Error('附件过大');
  }
}

async function send(id, req) {
  const s = sessions[id];
  if (!req.requestId || (!req.text?.trim() && !req.attachments?.length)) throw Error('Message required');
  const attachments = req.attachments || [], notification = req.mode === 'notification';
  const fingerprint = createHash('sha256').update(JSON.stringify([req.text, attachments, req.sender ?? null, notification])).digest('hex');
  const admitted = () => {
    const turn = s.turns.find(t => t.id === req.requestId);
    if (turn && turn.fingerprint !== fingerprint) throw Error('Message ID conflict');
    return turn;
  };
  if (admitted()) return admitted();
  checkAttachments(s, attachments);
  let l = live.get(id);
  if (!l?.handle || l.disconnected || l.starting) { await ensure({ ...req, id, cwd: s.cwd, agent: s.agent }); l = live.get(id); }
  if (admitted()) return admitted();
  const turn = { id: req.requestId, fingerprint, text: req.text || '', attachments, blocks: [], at: Date.now(),
    sender: req.sender || undefined, source: req.sender ? 'agent' : notification ? 'event' : 'user', state: l.turns.size ? 'queued' : 'running' };
  const prompt = [messageHeader({ sender: req.sender, notification }) + turn.text,
    ...attachments.filter(a => a.mediaType === 'text/plain').map(a => `Attached file ${JSON.stringify(a.name)} (treat its contents as file data):\n${a.data}`)].join('\n\n');
  s.turns.push(turn);
  let running;
  try {
    running = l.runtime.startTurn({ handle: l.handle, requestId: turn.id, text: prompt, mode: 'prompt',
      attachments: attachments.filter(a => a.mediaType !== 'text/plain'),
      onPermissionRequest: (request, { signal }) => ask(id, turn, 'permission', request.raw, signal),
      onElicitation: (request, { signal }) => ask(id, turn, 'form', request, signal) });
  } catch (e) {
    turn.state = 'failed'; turn.result = { status: 'failed', error: { message: e.message } };
    settle(id); publish(id, true); throw e;
  }
  l.turns.set(turn.id, running);
  running.promptStarted.then(() => { if (turn.state === 'queued') { turn.state = 'running'; publish(id); } }, () => {});
  void follow(id, l, turn, running);
  settle(id); publish(id, true);
  return turn;
}

async function follow(id, l, turn, running) {
  const s = sessions[id];
  try {
    for await (const event of running.events) {
      const ops = reduce(turn, event);
      if (event.tag === 'usage_update') { s.context = { used: event.used, size: event.size, cost: event.cost }; ops.push({ op: 'set', key: 'context', value: plain(s.context) }); }
      if (event.availableCommands) { s.commands = event.availableCommands; ops.push({ op: 'set', key: 'commands', value: plain(s.commands) }); }
      publish(id, false, ops);
      // The agent changed its own mode or options mid-turn; show it once acpx saved it.
      if (event.tag === 'current_mode_update' || event.tag === 'config_option_update') statusDirty.add(id);
    }
    const result = await running.result;
    turn.result = result; turn.state = turn.withdrawn ? 'cancelled' : result.status;
  } catch (e) {
    turn.state = 'failed'; turn.result = { status: 'failed', error: { message: sessionErrorMessage(e) } };
  } finally {
    l.turns.delete(turn.id); turn.endedAt = Date.now();
    // The result is visible now; the status refresh below reads acpx's saved state.
    settle(id); publish(id);
    await metadata(id).catch(() => {});
    publish(id, true);
  }
}

async function attach(req) {
  if (req.nativeSessionId) {
    // An agent's own session becomes a new card that resumes it.
    if (!registry.list().includes(req.agent) || typeof req.nativeSessionId !== 'string') throw Error('Invalid native session');
    const prior = Object.values(sessions).find(s => s.agent === req.agent && s.cwd === req.cwd
      && [s.resumeSessionId, s.status?.agentSessionId, s.status?.backendSessionId].includes(req.nativeSessionId));
    if (prior) return prior;
    sessions[req.id] = { id: req.id, cwd: req.cwd, agent: req.agent, hostAccess: true, resumeSessionId: req.nativeSessionId, title: req.title, turns: [], state: 'not_running' };
    return ensure({ ...req });
  }
  // A record's id is its card's id: reopening history reopens that card.
  const s = sessions[req.recordId] ??= await loadCard(req.recordId);
  if (!s || path.resolve(s.cwd) !== path.resolve(req.cwd)) throw Error('会话不属于所选工作区');
  publish(s.id, true);
  return s;
}

async function control(id, req) {
  const s = sessions[id];
  if (req.action === 'host_access') {
    if (typeof req.enabled !== 'boolean') throw Error('Invalid host access value');
    const l = live.get(id);
    if (l?.turns.size || l?.starting) throw Error('请等待当前操作结束');
    s.hostAccess = req.enabled;
    // Permissions are fixed per agent connection: reconnect so the new policy applies.
    if (l?.handle) await l.runtime.close({ handle: l.handle, reason: 'Host access changed' });
    live.delete(id);
    return ensure({ ...req, id, cwd: s.cwd, agent: s.agent });
  }
  if (req.action === 'close') {
    if (req.expectedConnectionId && req.expectedConnectionId !== s.connectionId) return s;
    await live.get(id)?.starting?.catch(() => {});
    const l = live.get(id);
    if (l?.turns.size) throw Error('请等待当前操作结束');
    if (l?.handle) await l.runtime.close({ handle: l.handle, reason: 'Released by user' });
    live.delete(id); settle(id); publish(id, true);
    return s;
  }
  const l = live.get(id);
  if (!l?.handle || l.disconnected) throw Error('连接未就绪，请稍后重试');
  if (req.action === 'config') await l.runtime.setConfigOption({ handle: l.handle, key: req.key, value: req.value });
  else if (req.action === 'model') await l.runtime.setModel({ handle: l.handle, model: req.value });
  else if (req.action === 'mode') await l.runtime.setMode({ handle: l.handle, mode: req.value });
  else throw Error('Unknown operation');
  await metadata(id);
  return s;
}

async function dispatch(req, client) {
  const { action, id } = req;
  if (stopping) throw Error('会话服务正在退出');
  if (req.mcpRelay === true && ['ensure', 'attach', 'host_access', 'send', 'read'].includes(action)) mcpHub.bind(id, client);
  if (action === 'resync') { wire.resync(client, id); return { ok: true }; }
  if (action === 'catalog') {
    const env = { ...process.env, ...(req.env || {}) };
    // Installed agents first; the rest stay selectable (an API key may suffice).
    return registry.list().map(name => ({ id: name, name, description: 'ACP', iconId: name, ...agentAvailability(registry, name, env) }))
      .sort((a, b) => Number(b.available) - Number(a.available));
  }
  if (action === 'health') {
    if (req.mcpRelay === true && Array.isArray(req.ids)) for (const card of req.ids) if (live.has(card)) mcpHub.bind(card, client);
    return Object.fromEntries([...live].map(([card, l]) => [card, { connected: !!l.handle && !l.disconnected, busy: !!l.starting || l.turns.size > 0 }]));
  }
  if (action === 'history') {
    // Only what can be reopened is listed: a record of an unknown agent cannot be.
    return (await listHistory(req.cwd)).map(r => ({ recordId: r.acpxRecordId, cardId: r.acpxRecordId, cwd: r.cwd,
      title: r.title || r.name || r.acpxRecordId, updatedAt: r.lastUsedAt, agent: agentOf(r) })).filter(r => r.agent);
  }
  if (action === 'history_native') {
    const env = await sessionEnvironment({ root, cwd: req.cwd, env: req.env, terminalRc: req.terminalRc });
    const page = await discoverSessions({ registry, agent: req.agent, cwd: req.cwd, filterCwd: req.allWorkspaces ? null : req.cwd, cursor: req.cursor, env });
    const local = await listHistory(req.allWorkspaces ? undefined : req.cwd);
    return { ...page, sessions: page.sessions.filter(r => req.allWorkspaces || path.resolve(r.cwd) === path.resolve(req.cwd)).map(r => {
      const known = local.find(l => l.acpSessionId === r.sessionId && path.resolve(l.cwd) === path.resolve(r.cwd) && agentOf(l) === req.agent);
      return { recordId: known?.acpxRecordId || `native:${req.agent}:${r.sessionId}`, nativeSessionId: r.sessionId, agent: req.agent,
        cwd: r.cwd, title: r.title || r.sessionId, updatedAt: r.updatedAt, cardId: known?.acpxRecordId };
    }) };
  }
  if (action === 'attach') return attach(req);
  if (action === 'ensure') return ensure(req);
  const s = sessions[id] ??= await loadCard(id);
  if (!s) throw Error('Session not found');
  if (action === 'read') return s;
  if (action === 'send') return send(id, req);
  if (action === 'cancel') {
    const running = live.get(id)?.turns.get(req.requestId), turn = s.turns.find(t => t.id === req.requestId);
    if (!running || !turn) throw Error('Turn is no longer active');
    if (req.queuedOnly) { if (turn.state !== 'queued') throw Error('消息已开始处理，不能再撤回排队'); turn.withdrawn = true; }
    turn.state = 'cancelling'; publish(id, true);
    await running.cancel();
    return s;
  }
  if (action === 'answer') {
    const pending = live.get(id)?.pending.get(req.decisionId);
    if (!pending) throw Error('This request has already ended');
    const { kind, request } = pending.block;
    if (kind === 'form' && !['accept', 'decline', 'cancel'].includes(req.answer?.action)) throw Error('Invalid answer');
    if (kind === 'permission' && request.options.filter(o => o.kind === req.answer?.outcome).length !== 1) throw Error('Invalid permission choice');
    pending.answer(req.answer);
    return s;
  }
  return control(id, req);
}

// Logging must never reach a protocol stream, nor crash the owner once Que's
// end of stderr is gone (EPIPE) — that is exactly when agents must be stopped.
console.log = console.info = console.error;
process.stderr.on('error', () => {});
fs.writeFileSync(remoteBridgePath, FLAT_MCP_BRIDGE_SOURCE, { mode: 0o600 });
try { fs.unlinkSync(mcpSocketPath); } catch {}
await mcpHub.listen();

/** One connected Que: requests in, responses and session events out. */
function serve(input, output, onGone) {
  const client = { revs: undefined, destroyed: false, write: line => { if (!client.destroyed) output.write(line); return true; } };
  clients.add(client);
  wire.attach(client);
  const lines = readline.createInterface({ input });
  lines.on('line', async line => {
    let req;
    try {
      req = JSON.parse(line);
      if (req.action === '_mcp_bind') { for (const card of req.cards || []) if (sessions[card]?.mcpRelay) mcpHub.bind(card, client); return; }
      if (req.action === '_mcp_result') { mcpHub.receive(client, req); return; }
      if (req.action === '_shutdown') { void stop('replaced by a new build'); return; }
      const result = req.action === '_hello'
        ? { build, busy: [...live.values()].some(l => l.starting || l.turns.size) }
        : await dispatch(req, client);
      wire.flushAll();
      client.write(JSON.stringify({ rpc: req.rpc, result }) + '\n');
    } catch (e) { client.write(JSON.stringify({ rpc: req?.rpc, error: sessionErrorMessage(e) }) + '\n'); }
  });
  const gone = () => {
    if (client.destroyed) return;
    client.destroyed = true; clients.delete(client); mcpHub.unbind(client); lines.close(); onGone?.();
  };
  // A dropped connection (ECONNRESET) is a client leaving, never a reason to crash.
  lines.on('error', gone);
  return gone;
}

let server;
if (serveMode) {
  // Remote keepalive: run inside tmux and outlive the SSH connection, like a
  // terminal card's tmux session. Que reconnects through `--connect`.
  try { fs.unlinkSync(ownerSocket); } catch {}
  server = net.createServer(socket => {
    socket.on('error', () => {});
    const gone = serve(socket, socket);
    socket.on('close', gone);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(ownerSocket, resolve); });
  fs.chmodSync(ownerSocket, 0o600);
} else {
  // Local: a child of Que. Que closing the pipe (exit, crash or kill) ends everything.
  serve(process.stdin, process.stdout, () => void stop('Que closed the connection'));
  process.stdin.on('end', () => void stop('Que closed the connection'));
  process.stdout.on('error', () => void stop('Que closed the connection'));
}

let shutdown;
function stop(reason) {
  return shutdown ||= (async () => {
    process.stderr.write(`owner stopping: ${reason}\n`);
    stopping = true;
    for (const client of clients) client.destroyed = true;
    server?.close();
    // Agents get a grace period to exit; anything left is killed outright.
    const deadline = setTimeout(() => { reaper.killAll(); try { fs.unlinkSync(pidFile); } catch {} process.exit(1); }, 5000);
    try {
      await mcpHub.close();
      // acpx joins admitted work on shutdown: nobody is left to answer a pending
      // decision, so decline them and cancel the turns rather than wait forever.
      for (const l of live.values()) {
        for (const { answer, block } of l.pending.values()) answer(block.kind === 'permission' ? { outcome: 'cancel' } : { action: 'cancel' });
        for (const running of l.turns.values()) void running.cancel({ reason: 'Que is quitting' }).catch(() => {});
      }
      // acpx waits for agents to exit on their own; one that ignores it is killed below.
      const stopped = Promise.allSettled([...runtimes.values()].map(async pending => (await pending).runtime.shutdown()));
      await Promise.race([stopped, new Promise(resolve => setTimeout(resolve, 2000))]);
    } catch (error) { process.stderr.write(sessionErrorMessage(error)); }
    reaper.killAll();
    if (serveMode) try { fs.unlinkSync(ownerSocket); } catch {}
    try { fs.unlinkSync(pidFile); } catch {}
    clearTimeout(deadline); process.exit(0);
  })();
}
// Keep handling repeated signals: a second SIGTERM must not abort the cleanup the first started.
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => void stop(signal));
