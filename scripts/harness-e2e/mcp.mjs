// Real Que HTTP + PTY + long-lived stdio MCP clients. No model required.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createServer, request as httpRequest } from 'node:http';
const binary = path.resolve(process.argv[2]);
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'que-mcp-test-'));
const children = [];
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exit = new Promise(resolve => child.once('exit', resolve));
  child.stdin.end();
  const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
  await exit; clearTimeout(timer);
}
async function start(profile, reuse = false) {
  const child = spawn(binary, [profile, ...(reuse ? ['--reuse-profile'] : [])], { env: { ...process.env, SHELL: '/bin/sh' }, stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(child);
  let errors = ''; child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-4000); });
  let controlId = 0;
  const waiting = new Map();
  const control = (method, args = {}) => new Promise((resolve, reject) => {
    const id = ++controlId;
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error('Native test control timed out')); }, 10000);
    waiting.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ method, ...args, controlId: id }) + '\n');
  });
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Startup timeout')); }, 30000);
    const reader = createInterface({ input: child.stdout });
    reader.on('line', line => {
      if (!line.startsWith('{')) return;
      const value = JSON.parse(line);
      if (value.base) { clearTimeout(timeout); resolve({ child, control, ...value }); }
      else if (value.controlId) {
        const p = waiting.get(value.controlId); if (!p) return;
        waiting.delete(value.controlId); clearTimeout(p.timer);
        if (value.error) p.reject(new Error(value.error)); else p.resolve(value.result);
      }
    });
    child.once('exit', () => { clearTimeout(timeout); reject(new Error(errors || 'Server exited')); });
  });
}
async function api(server, body, route = '/api/card-queue', token) {
  const response = await fetch(server.base + route, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, data: await response.json() };
}
async function ok(...args) { const result = await api(...args); assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data; }
function bridge(script, env = {}) {
  const child = spawn(process.execPath, [script], { env: { ...process.env, QUE_HARNESS_SIGNAL_DIR: '', ...env }, stdio: ['pipe', 'pipe', 'pipe'] }); children.push(child);
  child.stderr.on('data', () => {});
  let id = 0; const waiting = new Map();
  createInterface({ input: child.stdout }).on('line', line => {
    const response = JSON.parse(line); const pending = waiting.get(response.id);
    if (pending) { clearTimeout(pending.timer); waiting.delete(response.id); pending.resolve(response); }
  });
  return (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => { waiting.delete(requestId); reject(new Error('MCP response timed out')); }, 25000);
    waiting.set(requestId, { resolve, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
  });
}
async function call(rpc, name, args = {}) {
  const response = await rpc('tools/call', { name, arguments: args });
  assert(!response.error, JSON.stringify(response));
  return response.result;
}
async function tool(rpc, name, args = {}) {
  const result = await call(rpc, name, args); assert(!result.isError, JSON.stringify(result));
  return JSON.parse(result.content[0].text);
}
async function waitFor(predicate) {
  for (let i = 0; i < 50; i++) { if (await predicate()) return; await new Promise(r => setTimeout(r, 100)); }
  assert.fail('Timed out waiting for terminal output');
}
let uiServer;
try {
  let server = await start(path.join(root, 'profile'));
  const config = await ok(server, undefined, '/api/mcp/config');
  const script = config.mcpServers.que.args[0];
  assert(!JSON.stringify(config).includes('token'));
  const descriptor = path.join(path.dirname(script), 'endpoint.json');
  const initial = JSON.parse(await fs.readFile(descriptor, 'utf8'));
  if (process.platform !== 'win32') assert.equal((await fs.stat(descriptor)).mode & 0o777, 0o600);
  assert.equal((await api(server, { tool: 'list_cards' }, '/api/mcp/tools')).status, 401);
  const rpc = bridge(script);
  assert.equal((await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } })).result.serverInfo.name, 'que');
  const listed = (await rpc('tools/list')).result.tools;
  assert.equal(listed.length, 7); assert(listed.find(t => t.name === 'read_terminal').annotations.readOnlyHint);
  assert.equal((await tool(rpc, 'list_cards')).cards.length, 0); // No helper session required.
  const workspace = path.join(root, 'workspace'); await fs.mkdir(workspace);
  let queue = await ok(server, { action: 'workspace_create', kind: 'local', name: 'MCP test', cwd: workspace, createCard: true });
  const card = queue.cards.find(c => c.cwd === workspace);
  assert.equal((await tool(rpc, 'list_cards')).cards[0].state, 'not_started');
  const starter = bridge(script);
  const startAction = { cardId: card.id, kind: 'shell', requestId: 'start-denied' };
  const deniedStart = await tool(starter, 'start_card', startAction);
  assert.equal(deniedStart.delivery, 'approval-required');
  assert.equal((await tool(rpc, 'list_cards')).cards[0].state, 'not_started');
  assert.equal((await server.control('mcp_pending'))[0].tool, 'start_card');
  await server.control('mcp_decide', { id: deniedStart.approvalId, approve: false });
  assert.equal((await tool(starter, 'start_card', startAction)).delivery, 'denied');
  const approvedAction = { ...startAction, requestId: 'start-approved' };
  const startPending = await tool(starter, 'start_card', approvedAction);
  assert.deepEqual(await tool(starter, 'start_card', approvedAction), startPending);
  await server.control('mcp_decide', { id: startPending.approvalId, approve: true });
  const started = await tool(starter, 'get_request_status', { requestId: startPending.requestId });
  assert.equal(started.delivery, 'started', JSON.stringify(started));
  const terminalId = started.terminalId;
  assert((await tool(starter, 'read_terminal', { cardId: card.id, terminalId })).readToken);
  assert.deepEqual(await tool(starter, 'start_card', approvedAction), started);
  assert.equal((await tool(starter, 'start_card', { ...approvedAction, requestId: 'already-running' })).delivery, 'already-running');
  assert.equal((await tool(rpc, 'list_cards')).cards.find(c => c.cardId === card.id).terminalId, terminalId);
  const target = { cardId: card.id, terminalId };
  const pending = await tool(rpc, 'read_terminal', target);
  assert.equal(pending.delivery, 'approval-required');
  assert(!pending.terminal && !pending.readToken);
  assert.deepEqual(await tool(rpc, 'observe_terminal', target), pending);
  assert.equal((await server.control('mcp_pending')).length, 1);
  assert.equal((await fetch(server.base + '/api/mcp/decide', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + initial.token }, body: JSON.stringify({ id: pending.approvalId, approve: true }) })).status, 404);
  await server.control('mcp_decide', { id: pending.approvalId, approve: true });
  assert.equal((await tool(rpc, 'get_request_status', { requestId: pending.requestId })).delivery, 'authorized');
  assert.equal(await fs.readFile(path.join(workspace, 'result.txt'), 'utf8').catch(() => ''), '');
  const before = await tool(rpc, 'read_terminal', target);
  const action = { ...target, requestId: 'once', readToken: before.readToken, text: 'printf mcp-ok >> result.txt' };
  const receipt = await tool(rpc, 'send_text', action);
  assert.equal(receipt.delivery, 'written'); assert.equal(receipt.execution, 'unconfirmed');
  assert.deepEqual(await tool(rpc, 'send_text', action), receipt);
  await waitFor(async () => (await fs.readFile(path.join(workspace, 'result.txt'), 'utf8').catch(() => '')) === 'mcp-ok');
  assert.equal((await tool(rpc, 'observe_terminal', { ...target, after: receipt.beforeOffset })).outputChanged, true);
  const secondRead = await tool(rpc, 'read_terminal', target);
  assert.equal((await tool(rpc, 'send_text', { ...action, requestId: 'twice', readToken: secondRead.readToken, text: 'printf second > second.txt' })).delivery, 'written');
  assert.equal((await server.control('mcp_pending')).length, 0);
  assert((await call(rpc, 'send_text', { ...action, text: 'different' })).isError);
  const deniedRpc = bridge(script);
  const denied = await tool(deniedRpc, 'read_terminal', target);
  await server.control('mcp_decide', { id: denied.approvalId, approve: false });
  assert.equal((await tool(deniedRpc, 'get_request_status', { requestId: denied.requestId })).delivery, 'denied');
  assert.equal((await server.control('mcp_pending')).length, 0);
  const renewed = await tool(deniedRpc, 'read_terminal', target);
  assert.equal(renewed.delivery, 'approval-required');
  assert.notEqual(renewed.approvalId, denied.approvalId);
  assert.notEqual(renewed.requestId, denied.requestId);
  assert.deepEqual(await tool(deniedRpc, 'observe_terminal', target), renewed);
  assert.equal((await server.control('mcp_pending')).length, 1);
  await server.control('mcp_decide', { id: renewed.approvalId, approve: true });
  assert((await tool(deniedRpc, 'read_terminal', target)).readToken);
  assert((await tool(deniedRpc, 'observe_terminal', target)).readToken);
  assert.equal((await tool(deniedRpc, 'get_request_status', { requestId: denied.requestId })).delivery, 'denied');
  assert.equal((await server.control('mcp_pending')).length, 0);
  await assert.rejects(server.control('mcp_decide', { id: pending.approvalId, approve: true }));
  assert((await call(rpc, 'read_terminal', { ...target, terminalId: 'wrong' })).isError);
  const rpc2 = bridge(script);
  const access2 = await tool(rpc2, 'read_terminal', target);
  assert.equal(access2.delivery, 'approval-required');
  await server.control('mcp_decide', { id: access2.approvalId, approve: true });
  const stale = await tool(rpc2, 'read_terminal', target);
  assert((await call(rpc, 'send_text', { ...action, requestId: 'foreign-read', readToken: stale.readToken })).isError);
  await ok(server, { type: 'input', human: true, data: 'unfinished' }, `/api/terminal/${terminalId}`);
  assert.match((await tool(rpc2, 'send_text', { ...action, requestId: 'human', readToken: stale.readToken })).error, /Input changed/);
  const draft = await tool(rpc, 'read_terminal', target);
  assert.match((await tool(rpc, 'send_text', { ...action, requestId: 'draft', readToken: draft.readToken })).error, /unfinished input/);
  await ok(server, { type: 'input', human: true, data: '\x03' }, `/api/terminal/${terminalId}`);
  // Card-to-card grants are shared by bridges in the same source run, never by another source.
  const sourceWorkspace = path.join(root, 'source'); await fs.mkdir(sourceWorkspace);
  queue = await ok(server, { action: 'workspace_create', kind: 'local', name: 'Source', cwd: sourceWorkspace, createCard: true });
  const sourceCard = queue.cards.find(c => c.cwd === sourceWorkspace);
  queue = await ok(server, { action: 'harness_start', id: sourceCard.id, kind: 'shell', tmux: false });
  const sourceTerminal = queue.cards.find(c => c.id === sourceCard.id).harness.terminalId;
  const sourceEnv = { QUE_HARNESS_SIGNAL_DIR: '/signals/' + sourceTerminal };
  const sourceRpc = bridge(script, sourceEnv);
  const sourcePending = await tool(sourceRpc, 'read_terminal', target);
  const sibling = bridge(script, sourceEnv);
  assert.deepEqual(await tool(sibling, 'read_terminal', target), sourcePending);
  assert.equal((await server.control('mcp_pending')).length, 1);
  await server.control('mcp_decide', { id: sourcePending.approvalId, approve: true });
  assert.equal((await tool(sibling, 'get_request_status', { requestId: sourcePending.requestId })).delivery, 'authorized');
  assert((await tool(sourceRpc, 'read_terminal', target)).readToken);
  assert((await tool(sibling, 'read_terminal', target)).readToken);
  const reverse = bridge(script, { QUE_HARNESS_SIGNAL_DIR: '/signals/' + terminalId });
  const reversePending = await tool(reverse, 'read_terminal', { cardId: sourceCard.id, terminalId: sourceTerminal });
  assert.equal(reversePending.delivery, 'approval-required'); // A -> B never grants B -> A.
  await server.control('mcp_decide', { id: reversePending.approvalId, approve: false });
  await ok(server, { type: 'input', human: true, data: 'exit\r' }, `/api/terminal/${sourceTerminal}`);
  await waitFor(async () => !(await tool(rpc, 'list_cards')).cards.find(c => c.cardId === sourceCard.id).controllable);
  assert((await call(sourceRpc, 'read_terminal', target)).isError);
  await ok(server, { action: 'archive', id: sourceCard.id });
  assert((await call(sourceRpc, 'read_terminal', target)).isError);
  // Target lifecycle change invalidates a pending approval as well as existing grants.
  const pendingRpc = bridge(script);
  const changed = await tool(pendingRpc, 'read_terminal', target);
  await ok(server, { action: 'archive', id: card.id });
  assert.match((await server.control('mcp_decide', { id: changed.approvalId, approve: true })).error, /run ended or changed/);
  assert((await call(rpc, 'read_terminal', target)).isError);
  await ok(server, { action: 'restore', id: card.id });
  // Another profile never accepts this instance's token or exposes its cards.
  const other = await start(path.join(root, 'other'));
  assert.equal((await api(other, { tool: 'list_cards' }, '/api/mcp/tools', initial.token)).status, 401);
  const otherConfig = await ok(other, undefined, '/api/mcp/config');
  assert.equal((await tool(bridge(otherConfig.mcpServers.que.args[0]), 'list_cards')).cards.length, 0);
  await stop(other.child);
  await stop(server.child);
  assert((await call(rpc, 'list_cards')).isError);
  server = await start(path.join(root, 'profile'), true);
  const current = JSON.parse(await fs.readFile(descriptor, 'utf8'));
  assert.notEqual(current.token, initial.token);
  assert.equal((await api(server, { tool: 'list_cards' }, '/api/mcp/tools', initial.token)).status, 401);
  // Same running bridge discovers the new endpoint and reports the stopped card honestly.
  const restarted = (await tool(rpc, 'list_cards')).cards.find(c => c.cardId === card.id);
  assert.equal(restarted.state, 'not_running'); assert.equal(restarted.controllable, false);
  assert((await call(rpc, 'send_text', action)).isError); // Old read token cannot replay a write.
  assert.equal(await fs.readFile(path.join(workspace, 'result.txt'), 'utf8'), 'mcp-ok');
  const resumePending = await tool(starter, 'start_card', { cardId: card.id, requestId: 'start-stopped' });
  assert.equal(resumePending.delivery, 'approval-required');
  await server.control('mcp_decide', { id: resumePending.approvalId, approve: true });
  const resumed = await tool(starter, 'get_request_status', { requestId: resumePending.requestId });
  assert.equal(resumed.delivery, 'started', JSON.stringify(resumed));
  assert.notEqual(resumed.terminalId, terminalId);
  assert((await tool(starter, 'read_terminal', { cardId: card.id, terminalId: resumed.terminalId })).readToken);
  console.log('PASS: MCP start blank/stopped cards, denied start, start deduplication, no restart of live cards, run-scoped pair authorization, read gating, repeated input without prompts, source sharing, reverse-pair isolation, denial, lifecycle invalidation, real PTY execution, human takeover, profile isolation and restart recovery.');
  if (process.argv.includes('--serve')) {
    const dist = path.resolve('dist');
    uiServer = createServer(async (req, res) => {
      // Test fixture only: the real app uses native Tauri IPC, never HTTP approvals.
      if (req.url === '/__test_control' && req.method === 'POST') {
        let raw = ''; for await (const chunk of req) raw += chunk;
        try { const { method, args } = JSON.parse(raw); res.end(JSON.stringify(await server.control(method, args))); }
        catch (error) { res.writeHead(400); res.end(JSON.stringify({ error: error.message })); }
        return;
      }
      if (req.url.startsWith('/api/')) {
        const upstream = httpRequest(server.base + req.url, { method: req.method, headers: req.headers }, reply => { res.writeHead(reply.statusCode, reply.headers); reply.pipe(res); });
        upstream.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(upstream); res.on('close', () => upstream.destroy()); return;
      }
      const pathname = new URL(req.url, 'http://localhost').pathname;
      const file = path.resolve(dist, '.' + (pathname === '/' ? '/index.html' : pathname));
      if (!file.startsWith(dist + path.sep)) { res.writeHead(403); res.end(); return; }
      try {
        let data = await fs.readFile(file);
        if (path.extname(file) === '.html') data = Buffer.from(data.toString().replace('<head>', `<head><script>window.__TAURI_INTERNALS__={invoke:async(cmd,args)=>{if(cmd==='api_base')return location.origin;if(cmd==='mcp_pending'||cmd==='mcp_decide'){const r=await fetch('/__test_control',{method:'POST',body:JSON.stringify({method:cmd,args})});const d=await r.json();if(!r.ok)throw Error(d.error);return d}return null},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},transformCallback:()=>0,unregisterCallback:()=>{}};</script>`));
        res.writeHead(200, { 'Content-Type': { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml' }[path.extname(file)] || 'application/octet-stream' }); res.end(data);
      } catch { res.writeHead(404); res.end(); }
    });
    await new Promise(resolve => uiServer.listen(0, '127.0.0.1', resolve));
    console.log(`UI fixture: http://127.0.0.1:${uiServer.address().port}`);
    await new Promise(resolve => { process.once('SIGTERM', resolve); process.once('SIGINT', resolve); });
  }
} finally {
  uiServer?.closeAllConnections(); uiServer?.close();
  for (const child of children.reverse()) await stop(child);
  await fs.rm(root, { recursive: true, force: true });
}
