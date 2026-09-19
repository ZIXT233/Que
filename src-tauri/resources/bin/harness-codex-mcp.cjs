// Persistent lifecycle sink. Codex invokes this tool from hooks, not via a shell.
const { deliver } = require('./hook.cjs');
const readline = require('node:readline');
const events = new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'Stop']);
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.id === undefined) return;
  if (request.method === 'initialize') return send(request.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'que-session-state', version: '1.0.0' } });
  if (request.method === 'tools/list') return send(request.id, { tools: [{ name: 'session_state', description: 'Receive Codex lifecycle events from configured hooks. Do not call this tool manually.', inputSchema: { type: 'object', properties: { hook_event_name: { type: 'string', enum: [...events] }, session_id: { type: 'string' } }, required: ['hook_event_name', 'session_id'], additionalProperties: true } }] });
  if (request.method === 'tools/call' && request.params?.name === 'session_state') {
    const started = process.hrtime.bigint();
    const payload = request.params.arguments;
    if (!payload || !events.has(payload.hook_event_name) || typeof payload.session_id !== 'string') return send(request.id, { isError: true, content: [{ type: 'text', text: 'Invalid lifecycle event' }] });
    // Codex combines user and session hook sources rather than replacing them.
    // Ambient hooks must not duplicate per-card events through this same server.
    const internal = Boolean(process.env.QUE_HARNESS_SIGNAL_DIR || process.env.QUE_HARNESS_CHANNEL);
    if ((internal && payload.que_scope === 'external') || (!internal && payload.que_scope === 'internal')) return send(request.id, { content: [{ type: 'text', text: '{}' }] });
    deliver(payload);
    if (process.env.QUE_HOOK_DEBUG === '1' && process.env.QUE_HOOK_DEBUG_FILE) {
      try { require('node:fs').appendFileSync(process.env.QUE_HOOK_DEBUG_FILE, JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, stage: 'mcp-delivered', event: payload.hook_event_name, elapsedMs: Number(process.hrtime.bigint() - started) / 1e6 }) + '\n'); } catch {}
    }
    return send(request.id, { content: [{ type: 'text', text: '{}' }] });
  }
  if (request.method === 'ping') return send(request.id, {});
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } }) + '\n');
});
