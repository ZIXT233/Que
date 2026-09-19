// Pair by call_id, never by adjacency (see upstream issue #41942).
import fs from 'node:fs';
import assert from 'node:assert/strict';
const file = process.argv[2];
assert(file, 'Usage: node codex-rollout-timing.mjs ROLLOUT_JSONL');
const calls = new Map(), results = [];
for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
  const row = JSON.parse(line), p = row.payload;
  if (row.type !== 'response_item') continue;
  if (['function_call', 'custom_tool_call'].includes(p.type)) calls.set(p.call_id, { at: row.timestamp, name: p.name });
  if (['function_call_output', 'custom_tool_call_output'].includes(p.type)) {
    const call = calls.get(p.call_id);
    if (!call) continue;
    results.push({ callId: p.call_id, name: call.name, started: call.at, finished: row.timestamp, elapsedMs: Date.parse(row.timestamp) - Date.parse(call.at) });
    calls.delete(p.call_id);
  }
}
console.log(JSON.stringify({ file, results, warning: 'Tool boundary includes shell, sandbox, code-mode host and hooks; this is not hook-only latency.' }, null, 2));
