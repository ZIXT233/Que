// Real Que API -> PTY -> installed CLI -> hooks -> queue. No browser or GUI.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import xterm from '@xterm/headless';

const args = process.argv.slice(2);
const option = name => args[args.indexOf(name) + 1];
if (!args.includes('--base') || !args.includes('--manifest') || !args.includes('--allow-model-requests')) {
  console.error('Usage: node run.mjs --base http://127.0.0.1:PORT --manifest cases.json --allow-model-requests');
  process.exit(2);
}
const base = new URL(option('--base'));
assert(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname), 'Only a local Que server is supported');
const manifest = JSON.parse(await fs.readFile(option('--manifest'), 'utf8'));
assert(Array.isArray(manifest.cases) && manifest.cases.length, 'No cases');
const runRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'que-e2e-'));
console.log(`Reports and test workspaces: ${runRoot}`);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const api = async (route, body, method = body ? 'POST' : 'GET') => {
  const response = await fetch(new URL(route, base), {
    method, headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
  const text = await response.text();
  assert(response.ok, `${method} ${route}: ${response.status} ${text}`);
  return text ? JSON.parse(text) : null;
};
const queue = () => api('/api/card-queue');
const action = body => api('/api/card-queue', body);
assert((await queue()).cards.length === 0, 'Use an empty test Que profile: workspace selection can move an existing draft card');
const canonical = value => path.resolve(value || '').toLowerCase();
const report = [];
let interrupted = false;
process.on('SIGINT', () => { interrupted = true; });

for (const [index, spec] of manifest.cases.entries()) {
  if (interrupted) break;
  assert(['internal', 'external'].includes(spec.mode), 'Unknown mode');
  assert(spec.steps?.length && spec.steps.some(s => s.state || s.hook || s.externalState), 'Case must assert integration state');
  const cwd = path.join(runRoot, `case-${index}`);
  await fs.mkdir(cwd);
  const result = { name: spec.name, kind: spec.kind, mode: spec.mode, cwd, timeline: [] };
  let workspaceId, cardId, terminalId, stream, pump, poller, error, lastQueue, lastDebug;
  let raw = '', screen = '', inputAt = 0, stepAt = Date.now(), hookBaseline = 0;
  let hookBusySince = 0;
  const term = new xterm.Terminal({ cols: 100, rows: 35, allowProposedApi: true, scrollback: 2000 });
  const stamp = (type, data) => result.timeline.push({ at: Date.now(), type, data });
  const send = data => api(`/api/terminal/${terminalId}`, { type: 'input', data });
  // Terminal capability/color replies are produced by a real VT parser.
  term.onData(data => { send(data).catch(e => { error ||= e; }); });
  const failPattern = new RegExp(spec.errorPattern || 'hook[^\\n]*(?:timed out|exit(?:ed)? with code [1-9]|Failed)|plugin failed to load', 'i');
  try {
    if (spec.mode === 'external') {
      const settings = await api('/api/tools/settings');
      const key = spec.kind === 'omp' ? 'pi' : spec.kind === 'gemini' ? 'antigravity' : spec.kind;
      assert(settings.externalNoticesEnabled && settings.externalIngress?.[key] !== false, 'External capture is disabled');
      assert(spec.command, 'External case needs the ordinary CLI launch command');
      terminalId = (await api('/api/terminal', { cwd, cols: 100, rows: 35 })).id;
    } else {
      const q = await action({ action: 'workspace_create', kind: 'local', name: `E2E ${index}`, cwd, createCard: true });
      workspaceId = q.workspaces.find(w => canonical(w.cwd) === canonical(cwd))?.id;
      assert(workspaceId, 'Test workspace was not created');
      cardId = q.cards.find(c => c.workspaceId === workspaceId)?.id;
      assert(cardId, 'Test card was not created');
      const started = await action({ action: 'harness_start', id: cardId, kind: spec.kind });
      terminalId = started.cards.find(c => c.id === cardId)?.harness?.terminalId;
      assert(terminalId, 'Harness did not get a PTY');
    }
    await api(`/api/terminal/${terminalId}`, { type: 'resize', cols: 100, rows: 35 });
    stream = new AbortController();
    const response = await fetch(new URL(`/api/terminal/${terminalId}/events`, base), { signal: stream.signal });
    assert(response.ok && response.body, 'SSE connection failed');
    pump = (async () => {
      let buffer = '';
      for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          const packet = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const data = packet.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
          if (!data) continue;
          const event = JSON.parse(data);
          if (event.type === 'output') {
            if (event.dropped) throw new Error('PTY replay lost bytes');
            raw += event.data;
            if (event.reset) term.reset();
            await new Promise(resolve => term.write(event.data, resolve));
            const b = term.buffer.active;
            screen = Array.from({ length: term.rows }, (_, y) => b.getLine(b.viewportY + y)?.translateToString(true) || '').join('\n');
            if (failPattern.test(screen)) throw new Error(`CLI reported a hook/plugin error: ${screen}`);
            if (/running hooks?/i.test(screen)) hookBusySince ||= Date.now(); else hookBusySince = 0;
          } else if (event.type === 'exit' || event.type === 'closed') throw new Error(`CLI terminal ended: ${JSON.stringify(event)}`);
        }
      }
    })().catch(e => { if (!stream.signal.aborted) error ||= e; });
    let polling = true;
    poller = (async () => {
      while (polling && !interrupted) {
        lastQueue = await queue();
        lastDebug = spec.mode === 'internal' ? await api(`/api/harness/${terminalId}/debug`) : null;
        stamp('snapshot', { card: lastQueue.cards.find(c => c.id === cardId), external: lastQueue.external?.filter(n => canonical(n.cwd || n.workspaceRoot) === canonical(cwd)), debug: lastDebug });
        await sleep(200);
      }
    })().catch(e => { error ||= e; });
    result.stopPolling = () => { polling = false; };
    if (spec.mode === 'external') await send(`${spec.command}\r`);
    for (const step of spec.steps) {
      stepAt = Date.now();
      if (step.send !== undefined) {
        hookBaseline = Math.max(0, ...(lastDebug?.events || []).map(e => e.at));
        inputAt = Date.now();
        await send(step.send); stamp('input', step.send);
      }
      const deadline = Date.now() + (step.timeoutMs || 30000);
      while (true) {
        if (interrupted) throw new Error('Interrupted');
        if (error) throw error;
        if (hookBusySince && Date.now() - hookBusySince > (spec.maxRunningHookMs || 3000)) throw new Error('CLI remained in running hook beyond budget');
        const card = lastQueue?.cards.find(c => c.id === cardId);
        const hook = !step.hook || lastDebug?.events?.some(e => e.at > hookBaseline && ['hook', 'file'].includes(e.source) && e.event === step.hook);
        const external = !step.externalState || lastQueue?.external?.some(n => n.kind === spec.kind && canonical(n.cwd || n.workspaceRoot) === canonical(cwd) && n.state === step.externalState && n.at >= inputAt);
        const placement = !['working', 'attention'].includes(step.state) || (card?.phase === step.state && lastQueue.order.includes(cardId) === (step.state === 'attention'));
        if ((!step.screen || new RegExp(step.screen, 'i').test(screen)) && (!step.state || card?.harness?.state === step.state) && placement && hook && external && (!step.waitMs || Date.now() - stepAt >= step.waitMs)) break;
        assert(Date.now() < deadline, `Step timed out: ${JSON.stringify(step)}`);
        await sleep(50);
      }
      stamp('stepPassed', { step, elapsedMs: Date.now() - stepAt });
    }
    for (const [event, expected] of Object.entries(spec.hookCounts || {})) {
      const actual = lastDebug?.events?.filter(e => ['hook', 'file'].includes(e.source) && e.event === event).length || 0;
      assert.equal(actual, expected, `${event} delivered ${actual} times, expected ${expected}`);
    }
    result.status = 'passed';
  } catch (e) {
    result.status = 'failed'; result.error = e.stack || String(e);
  } finally {
    result.stopPolling?.(); delete result.stopPolling;
    stream?.abort(); await pump; await poller;
    if (error) { result.status = 'failed'; result.error ||= error.stack || String(error); }
    await fs.writeFile(path.join(cwd, 'terminal.txt'), raw);
    await fs.writeFile(path.join(cwd, 'screen.txt'), screen);
    // Delete only this run's terminal and unique workspace; preserve evidence on disk.
    try {
      if (terminalId) await api(`/api/terminal/${terminalId}`, undefined, 'DELETE');
      if (workspaceId) await action({ action: 'workspace_remove', workspaceId });
      for (const notice of lastQueue?.external || []) if (canonical(notice.cwd || notice.workspaceRoot) === canonical(cwd)) await action({ action: 'dismiss_external', id: notice.id });
    } catch (e) { result.cleanupError = String(e); result.status = 'failed'; }
    term.dispose();
    await fs.writeFile(path.join(cwd, 'report.json'), JSON.stringify(result, null, 2));
    report.push({ ...result, timeline: undefined });
    console.log(`${result.status}: ${spec.name}${result.error ? `\n${result.error}` : ''}`);
  }
}
await fs.writeFile(path.join(runRoot, 'summary.json'), JSON.stringify(report, null, 2));
process.exitCode = interrupted || report.some(r => r.status !== 'passed') ? 1 : 0;
