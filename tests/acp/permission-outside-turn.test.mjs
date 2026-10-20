import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

test('a permission request outside any turn is refused, never approved, and the card says so', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'que-late-permission-'));
  const answerFile = path.join(root, 'late-answer.json');
  writeFileSync(path.join(root, 'agents.json'), JSON.stringify({ fixture: [process.execPath, path.resolve('tests/acp/agent.mjs')] }));
  let child, serial = 0; const pending = new Map();
  const connect = () => {
    child = spawn(process.execPath, ['src-tauri/resources/bin/acp-owner.mjs'], { env: { ...process.env, QUE_ACP_ROOT: root, QUE_ACP_STORE_DIR: path.join(root, 'acpx'), QUE_TEST_LATE_FILE: answerFile }, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stderr.on('data', d => process.stderr.write(d));
    readline.createInterface({ input: child.stdout }).on('line', line => { const v = JSON.parse(line); if (v.rpc) { const p = pending.get(v.rpc); pending.delete(v.rpc); v.error ? p.reject(Error(v.error)) : p.resolve(v.result); } });
  };
  const rpc = body => new Promise((resolve, reject) => { const id = String(++serial); pending.set(id, { resolve, reject }); child.stdin.write(JSON.stringify({ ...body, rpc: id }) + '\n'); });
  const restart = async () => { const old = child; old.stdin.end(); for (let i = 0; i < 400 && old.exitCode === null && old.signalCode === null; i++) await new Promise(r => setTimeout(r, 20)); connect(); };
  const until = async predicate => { for (let i = 0; i < 300; i++) { const v = await predicate(); if (v) return v; await new Promise(r => setTimeout(r, 40)); } throw Error('Timeout'); };
  const refusal = snapshot => snapshot.turns.at(-1)?.blocks.find(b => b.type === 'decision' && b.state === 'refused');
  connect();
  try {
    await rpc({ action: 'ensure', id: 'card', agent: 'fixture', cwd: root });
    await rpc({ action: 'send', id: 'card', requestId: 'one', text: 'after-turn-request' });
    const answer = await until(() => existsSync(answerFile) && JSON.parse(readFileSync(answerFile, 'utf8')));
    assert.deepEqual(answer.outcome, { outcome: 'cancelled' }, 'the agent is refused through the protocol, not with one of its options');
    const shown = await until(async () => refusal(await rpc({ action: 'read', id: 'card' })));
    assert.equal(shown.request.toolCall.title, '后台写入文件', 'the card records what was refused');
    assert.equal((await rpc({ action: 'read', id: 'card' })).state !== 'attention', true, 'a refused request is not waiting for anyone');
    await until(async () => (await rpc({ action: 'read', id: 'card' })).turns.every(t => t.state === 'completed'));
    await rpc({ action: 'close', id: 'card' });
    await restart();
    await rpc({ action: 'ensure', id: 'card', agent: 'fixture', cwd: root });
    assert.ok(refusal(await rpc({ action: 'read', id: 'card' })), 'the record survives a restart');
  } finally {
    child.kill();
    try { process.kill(Number(readFileSync(path.join(root, 'owner.pid'), 'utf8'))); } catch {}
    for (let i = 0; i < 240 && existsSync(path.join(root, 'owner.pid')); i++) await new Promise(r => setTimeout(r, 50));
    rmSync(root, { recursive: true, force: true });
  }
});
