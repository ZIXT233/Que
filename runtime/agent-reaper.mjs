import fs from 'node:fs';

// Agents run in their own process groups (acpx spawns them detached on Unix), so
// a hard-killed owner would orphan them. Record every live agent; the next owner
// kills what is still running from the previous one.
// Only Linux can prove a recorded PID was not reused (process start time), so
// stale entries are reaped there and ignored elsewhere.
const identity = pid => {
  if (process.platform !== 'linux') return null;
  try { return fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').pop().split(' ')[19] ?? null; }
  catch { return null; }
};
const kill = (pid, signal) => {
  if (process.platform !== 'win32') try { process.kill(-pid, signal); } catch {}
  try { process.kill(pid, signal); } catch {}
};

export function agentReaper(file) {
  const live = new Map();
  const save = () => {
    try { fs.writeFileSync(file, JSON.stringify([...live].map(([pid, start]) => ({ pid, start }))), { mode: 0o600 }); } catch {}
  };
  return {
    add(pid) { if (pid) { live.set(pid, identity(pid)); save(); } },
    remove(pid) { if (live.delete(pid)) save(); },
    killAll(signal = 'SIGKILL') { for (const pid of live.keys()) kill(pid, signal); },
    reapStale() {
      let entries = [];
      try { entries = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
      let reaped = 0;
      for (const { pid, start } of Array.isArray(entries) ? entries : []) {
        if (start && identity(pid) === start) { kill(pid, 'SIGKILL'); reaped++; }
      }
      save();
      return reaped;
    },
  };
}
