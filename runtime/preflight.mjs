import fs from 'node:fs';
import path from 'node:path';

/** Resolves a command the way spawn would, against the agent's own PATH. */
export function findExecutable(command, env = process.env) {
  if (!command) return null;
  if (path.isAbsolute(command)) return fs.existsSync(command) ? command : null;
  // A relative path is resolved by the agent's cwd at spawn time; do not guess.
  if (command.includes('/') || command.includes('\\')) return command;
  const dirs = (env.PATH ?? env.Path ?? process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const extensions = process.platform === 'win32'
    ? ['', ...(env.PATHEXT ?? process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';')]
    : [''];
  for (const dir of dirs) for (const extension of extensions) {
    const candidate = path.join(dir, command + extension);
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch {}
  }
  return null;
}

/**
 * A missing CLI otherwise surfaces minutes later as a generic startup timeout.
 * Returns a user-facing reason, or null when the command can be launched.
 */
export function missingAgentCommand(registry, agent, env) {
  let resolved;
  try { resolved = registry.resolve(agent); } catch { return null; }
  const command = Array.isArray(resolved) ? resolved[0] : String(resolved ?? '').trim().split(/\s+/)[0];
  if (findExecutable(command, env)) return null;
  if (command === 'npx') return `启动 ${agent} 需要 npx（Node.js 自带），但当前工作区环境的 PATH 里找不到它。`;
  return `找不到 ${agent} 的命令行工具“${command}”。请先安装并登录它，并确保它在当前工作区环境的 PATH 中。`;
}

// npx adapters wrap a CLI that must itself be installed and signed in; npx
// existing says nothing about whether the agent can actually be used.
// Packages fetched by npx/uvx only count once their CLI is installed and set up.
const ADAPTER_CLI = { codex: 'codex', claude: 'claude', pi: 'pi', opencode: 'opencode', kilocode: 'kilocode', mux: 'mux', 'fast-agent': 'fast-agent' };

/** Whether this machine can run `agent`, for ordering the picker. Never blocks a choice. */
export function agentAvailability(registry, agent, env) {
  let resolved;
  try { resolved = registry.resolve(agent); } catch { return { available: false, missing: agent }; }
  const command = Array.isArray(resolved) ? resolved[0] : String(resolved ?? '').trim().split(/\s+/)[0];
  const needed = ['npx', 'uvx'].includes(command) ? ADAPTER_CLI[agent] ?? `${agent}（需通过 ${command} 下载）` : command;
  return findExecutable(needed, env) ? { available: true } : { available: false, missing: needed };
}
