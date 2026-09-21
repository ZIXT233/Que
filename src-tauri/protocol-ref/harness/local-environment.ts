import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, stat, readlink } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join, isAbsolute, dirname } from "node:path";
import { homedir } from "node:os";
const exec = promisify(execFile);
const START = "__QUE_ENV_START__", END = "__QUE_ENV_END__";
let cached: { key: string; expires: number; value: Promise<NodeJS.ProcessEnv> } | undefined;
export function localEnvironment(force = false): Promise<NodeJS.ProcessEnv> {
  const shell = process.platform === "win32" ? "powershell.exe" : process.env.SHELL || "/bin/sh";
  const key = `${shell}:${process.env.PATH ?? process.env.Path}`;
  if (!force && cached?.key === key && cached.expires > Date.now()) return cached.value;
  const value = (async () => {
    const command = process.platform === "win32"
      ? `$e=@{};[Environment]::GetEnvironmentVariables().GetEnumerator()|ForEach-Object{$e[$_.Key]=[string]$_.Value};[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);[Console]::Write('${START}');[Console]::Write(($e|ConvertTo-Json -Compress));[Console]::Write('${END}')`
      : `printf '${START}\\0'; /usr/bin/env -0; printf '${END}\\0'`;
    const { stdout } = await exec(shell, process.platform === "win32" ? ["-NoLogo", "-Command", command] : ["-ilc", command], { timeout: 10000, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
    const start = stdout.indexOf(START), end = stdout.indexOf(END, start + START.length);
    if (start < 0 || end < 0) throw new Error("未能读取 Shell 环境，请检查 Shell 配置中的启动命令");
    const body = stdout.slice(start + START.length, end);
    const parsed = process.platform === "win32" ? JSON.parse(body) : Object.fromEntries(body.split("\0").filter(v => v.includes("=")).map(v => { const i = v.indexOf("="); return [v.slice(0, i), v.slice(i + 1)]; }));
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const [key, val] of Object.entries(parsed)) if (typeof val === "string") {
      if (process.platform === "win32") for (const old of Object.keys(env)) if (old.toLowerCase() === key.toLowerCase()) delete env[old];
      env[key] = val;
    }
    return env;
  })().catch(error => { if (cached?.value === value) cached = undefined; throw new Error(`读取用户 Shell 环境失败：${error.message}`); });
  cached = { key, expires: Date.now() + 60000, value };
  return value;
}
export async function resolveLocalCommand(command: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const read = (key: string) => Object.entries(env).find(([k]) => k.toLowerCase() === key.toLowerCase())?.[1];
  const win = process.platform === "win32";
  const dirs = (read("PATH") || "").split(delimiter).filter(isAbsolute);
  // Bounded fallback for normal user-level installers; PATH retains precedence.
  dirs.push(join(homedir(), ".local", "bin"), join(homedir(), ".opencode", "bin"));
  if (win && read("APPDATA")) dirs.push(join(read("APPDATA")!, "npm"));
  const extensions = win ? (read("PATHEXT") || ".EXE;.CMD;.BAT;.COM").split(";") : [""];
  for (const dir of dirs) {
    // A PATH entry behind a user-created junction refuses traversal when the
    // process inherits the redirection-trust mitigation (MSI "launch now",
    // sshd). Resolve link targets — metadata reads the mitigation does not
    // gate — and probe the physical path instead.
    let probed = dir;
    if (win) { try { await stat(probed); } catch { probed = await resolveReparseChain(dir); } }
    for (const ext of extensions) {
      const candidate = join(probed, command + ext);
      try { if (!(await stat(candidate)).isFile()) continue; await access(candidate, win ? constants.F_OK : constants.X_OK); return candidate; } catch {}
    }
  }
}

async function resolveReparseChain(path: string): Promise<string> {
  // Substitute each reparse point component with its link target; a target may
  // itself contain links (Codex's `bin` junction lands on a `current`
  // junction), so repeat until stable. readlink never traverses the link.
  let current = path;
  for (let hop = 0; hop < 8; hop++) {
    const parts = current.split(/[\\/]+/).filter(Boolean);
    let resolved = /^[a-zA-Z]:$/.test(parts[0] ?? "") ? parts.shift()! + "\\" : "\\";
    let changed = false;
    for (const part of parts) {
      resolved = join(resolved, part);
      try {
        const target = await readlink(resolved);
        resolved = isAbsolute(target) ? target : join(dirname(resolved), target);
        changed = true;
      } catch {}
    }
    if (!changed) return current;
    current = resolved;
  }
  return current;
}
