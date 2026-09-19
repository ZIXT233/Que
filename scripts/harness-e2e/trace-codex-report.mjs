import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = process.argv[2];
assert(root, 'Usage: node trace-codex-report.mjs TRACE_DIRECTORY');
const read = name => fs.existsSync(path.join(root, name)) ? fs.readFileSync(path.join(root, name), 'utf8').replace(/^\uFEFF/, '').trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)) : [];
const run = JSON.parse(fs.readFileSync(path.join(root, 'run.json'), 'utf8').replace(/^\uFEFF/, ''));
const starts = read('start.jsonl').sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
const stops = read('stop.jsonl');
const hooks = read('hook.jsonl');
const descendants = new Set([run.rootPid]);
for (let changed = true; changed;) {
  changed = false;
  for (const p of starts) if (descendants.has(p.ppid) && !descendants.has(p.pid)) { descendants.add(p.pid); changed = true; }
}
const processes = starts.filter(p => descendants.has(p.pid)).map(p => {
  const stop = stops.find(s => s.pid === p.pid && Date.parse(s.at) >= Date.parse(p.at));
  const marks = hooks.filter(h => h.pid === p.pid);
  // WMI TIME_CREATED is provider emission time, not the kernel process time.
  // Batched events can even follow JS execution. Never infer latency from it.
  return { pid: p.pid, ppid: p.ppid, name: p.name, startObservedAt: p.at, stopObservedAt: stop?.at, exitCode: stop?.exitCode,
    hookMarks: marks.map(m => ({ stage: m.stage, at: m.ts, elapsedMs: m.elapsedMs, event: m.event })) };
});
const result = { run, processes, warnings: ['WMI timestamps identify event observations only; do not use them for process duration or startup latency.', ...(hooks.length ? [] : ['No hook marks: installed ingress may lack instrumentation or no Que hook ran.'])] };
fs.writeFileSync(path.join(root, 'timeline.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
