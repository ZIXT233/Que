import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

test('a mode or config change made by the agent mid-turn reaches the session before the turn ends', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'que-live-status-'));
  writeFileSync(path.join(root, 'agents.json'), JSON.stringify({ fixture: [process.execPath, path.resolve('tests/acp/agent.mjs')] }));
  const child = spawn(process.execPath, ['src-tauri/resources/bin/acp-owner.mjs'], { env: { ...process.env, QUE_ACP_ROOT: root, QUE_ACP_STORE_DIR: path.join(root, 'acpx') }, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.on('data', d => process.stderr.write(d));
  let serial = 0; const pending = new Map(), events = [];
  readline.createInterface({ input: child.stdout }).on('line', line => {
    const v = JSON.parse(line);
    if (v.event) events.push(v);
    if (v.rpc) { const p = pending.get(v.rpc); pending.delete(v.rpc); v.error ? p.reject(Error(v.error)) : p.resolve(v.result); }
  });
  const rpc = body => new Promise((resolve, reject) => { const id = String(++serial); pending.set(id, { resolve, reject }); child.stdin.write(JSON.stringify({ ...body, rpc: id }) + '\n'); });
  const mode = s => s.status?.details?.configOptions?.find(o => o.id === 'mode')?.currentValue;
  try {
    await rpc({ action: 'ensure', id: 'card', agent: 'fixture', cwd: root });
    assert.equal(mode(await rpc({ action: 'read', id: 'card' })), 'ask');
    await rpc({ action: 'send', id: 'card', requestId: 'r1', text: 'mid-turn-config' });
    const started = Date.now();
    let seen;
    while (Date.now() - started < 7000) { // the agent holds the turn for 8s; this normally takes well under 1s
      const snapshot = await rpc({ action: 'read', id: 'card' });
      if (mode(snapshot) === 'auto') { seen = snapshot; break; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(seen, 'the new mode is visible while the agent is still working');
    assert.equal(seen.turns.at(-1).state, 'running', 'the turn has not ended yet');
    // The stream carries it too, not only an explicit read.
    assert.ok(events.some(e => e.event === 'snapshot' && mode(e.snapshot) === 'auto'), 'subscribers receive the change');
  } finally {
    child.kill();
    try { process.kill(Number(readFileSync(path.join(root, 'owner.pid'), 'utf8'))); } catch {}
    // The owner removes owner.pid when it has shut down; deleting earlier lets it recreate files.
    for (let i = 0; i < 240 && existsSync(path.join(root, 'owner.pid')); i++) await new Promise(resolve => setTimeout(resolve, 50));
    rmSync(root, { recursive: true, force: true });
  }
});
