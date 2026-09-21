import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { inheritedConfig } from "./inherited-config";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { shellQuote, sshExec, sshLoginExec } from "../ssh-workspace";
import type { QueueWorkspace } from "../card-queue";
import type { HarnessId } from "./types";
import { embeddedNodeExecutable } from "../node-runtime";
import { CURSOR_HOOK_EVENTS, cursorHookStdout } from "./hook-contract";

// Session-local plugins preserve user/project settings. Cursor also merges
// ~/.cursor/hooks.json so its TUI will dispatch prompt/stop/response hooks.
export async function prepareHookLaunch(kind: HarnessId, directory: string, workspace: QueueWorkspace, token: string): Promise<{ args: string[]; env: Record<string, string> }> {
  const source = await readFile(join(process.cwd(), "bin/harness-hook.cjs"), "utf8");
  let root = join(directory, "..", "..", "harness-plugins", kind);
  if (workspace.kind === "local") await mkdir(directory, { recursive: true, mode: 0o700 });
  let node = embeddedNodeExecutable();
  const extraEnv: Record<string, string> = {};
  let grokConfigPath: string | undefined;
  let antigravityConfigPath: string | undefined;
  let cursorConfigPath: string | undefined;
  if (workspace.kind === "ssh") {
    const home = (await sshExec(workspace.sshHost!, 'printf "%s" "$HOME"')).toString().trim();
    if (!home.startsWith("/")) throw new Error("无法确定远程主机的 Home 目录");
    // Keep the Codex command stable across launches so hook trust is reusable;
    // changing the helper produces a new path and requires a fresh review.
    root = kind === "grok" ? `${home}/.cache/que/harness-plugins/grok`
      : kind === "codex" ? `${home}/.cache/que/harness-plugins/codex/${createHash("sha256").update(source).digest("hex").slice(0, 16)}`
      : kind === "cursor" ? `${home}/.cache/que/harness-plugins/cursor`
      : `${home}/.cache/que/harness/${token}`;
    if (kind === "cursor") cursorConfigPath = `${home}/.cursor/hooks.json`;
    node = (await sshLoginExec(workspace.sshHost!, "command -v node")).toString().trim();
    if (!node.startsWith("/")) throw new Error("远程 Harness 状态探针需要 Node.js，请先在主机安装 Node.js");
  }
  const hookPath = workspace.kind === "ssh" ? `${root}/hook.cjs` : join(root, "hook.cjs");
  // Claude uses a POSIX shell for hooks on Windows too (Git Bash).
  const quote = (value: string) => workspace.kind === "local" && process.platform === "win32"
    ? `"${value.replaceAll('"', '\\"')}"` : shellQuote(value);
  const nodeCommand = [node, hookPath].map(quote).join(" ");
  // CLI hook runners may sanitize inherited Electron variables.
  const electronNode = workspace.kind === "local" && (process.env.ELECTRON_RUN_AS_NODE === "1" || process.env.QUE_NODE_RUN_AS_NODE === "1");
  const legacyCommand = electronNode
    ? (process.platform === "win32" && kind !== "claude" ? `set "ELECTRON_RUN_AS_NODE=1" && ${nodeCommand}` : `ELECTRON_RUN_AS_NODE=1 ${nodeCommand}`)
    : nodeCommand;
  const windows = workspace.kind === "local" && process.platform === "win32";
  // Cursor starts its shell worker before running each Windows hook; its cold
  // startup counts toward this timeout as well as PowerShell and our helper.
  const hookTimeout = windows ? (kind === "cursor" ? 15 : 5) : 2;
  const commandFor = (event?: string) => {
    // Cursor's Windows hook worker is PowerShell. CMD `set VAR&&` fails there,
    // so never wrap the helper. Kind comes from argv; signal dir from process env.
    if (windows && kind === "cursor") {
      return [node, hookPath, ...(event ? [event] : [])].map(quote).join(" ");
    }
    if (windows) return windowsHookCommand(node, hookPath, electronNode, event);
    // Cursor TUI only dispatches prompt/stop/response from user/project hooks.
    // Bake the kind so IDE or other sessions still emit the required JSON.
    return `${kind === "cursor" ? "QUE_HARNESS_KIND=cursor " : ""}${legacyCommand}${event ? ` ${quote(event)}` : ""}`;
  };
  const command = commandFor();
  const files: Record<string, string> = { "hook.cjs": source };
  const args: string[] = [];
  if (kind === "antigravity") {
    const bundle = Object.fromEntries(["PreInvocation", "PostInvocation", "PreToolUse", "PostToolUse", "Stop"].map(event => {
      const hook = { type: "command", command: commandFor(event), timeout: hookTimeout };
      return [event, [event.endsWith("ToolUse") ? { matcher: "*", hooks: [hook] } : hook]];
    }));
    files["antigravity-hooks.json"] = JSON.stringify(bundle);
    antigravityConfigPath = workspace.kind === "ssh"
      ? `${(await sshExec(workspace.sshHost!, 'printf "%s" "$HOME"')).toString().trim()}/.gemini/config/hooks.json`
      : join(homedir(), ".gemini", "config", "hooks.json");
  } else if (kind === "gemini") {
    const config = await inheritedConfig("gemini", workspace, node);
    const hooks = { ...(config.hooks as Record<string, unknown> ?? {}) };
    for (const event of ["SessionStart", "BeforeAgent", "AfterAgent", "BeforeTool", "AfterTool", "Notification"]) {
      hooks[event] = [...(Array.isArray(hooks[event]) ? hooks[event] as unknown[] : []), { hooks: [{ type: "command", name: `que-${event}`, command, timeout: hookTimeout * 1000 }] }];
    }
    files["system-defaults.json"] = JSON.stringify({ ...config, hooks });
    extraEnv.GEMINI_CLI_SYSTEM_DEFAULTS_PATH = workspace.kind === "ssh" ? `${root}/system-defaults.json` : join(root, "system-defaults.json");
  } else if (kind === "opencode") {
    files["opencode-plugin.mjs"] = await readFile(join(process.cwd(), "bin/harness-opencode.mjs"), "utf8");
    const config = await inheritedConfig("opencode", workspace, node);
    const plugin = workspace.kind === "ssh" ? `file://${root.split("/").map(encodeURIComponent).join("/")}/opencode-plugin.mjs` : pathToFileURL(join(root, "opencode-plugin.mjs")).href;
    extraEnv.OPENCODE_CONFIG_CONTENT = JSON.stringify({ ...config, plugin: [...(Array.isArray(config.plugin) ? config.plugin : []), plugin] });
  } else if (kind === "grok") {
    const hooks = Object.fromEntries(["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop", "StopFailure", "StopCancelled", "Notification"].map(event => [event, [{ hooks: [{ type: "command", command, timeout: hookTimeout }] }]]));
    files["grok-hooks.json"] = JSON.stringify({ queManaged: true, hooks });
    if (workspace.kind === "ssh") {
      const configuredHome = (await sshExec(workspace.sshHost!, 'printf "%s" "${GROK_HOME:-$HOME/.grok}"')).toString().trim();
      grokConfigPath = `${configuredHome}/hooks/que-session-state.json`;
    } else grokConfigPath = join(process.env.GROK_HOME || join(homedir(), ".grok"), "hooks", "que-session-state.json");
  } else if (kind === "pi" || kind === "omp") {
    files["pi-extension.mjs"] = await readFile(join(process.cwd(), "bin/harness-pi.mjs"), "utf8");
    args.push("--extension", workspace.kind === "ssh" ? `${root}/pi-extension.mjs` : join(root, "pi-extension.mjs"));
  } else if (kind === "codex") {
    args.push("--enable", "hooks");
    for (const event of ["SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse", "Stop"]) {
      args.push("-c", `hooks.${event}=[{hooks=[{type="command",command=${JSON.stringify(command)},timeout=${hookTimeout}}]}]`);
    }
  } else if (kind === "devin") {
    // No plugin directory; `--config` swaps the user config file for this session,
    // so the merged copy carries the user's own settings plus Que's hooks.
    const config = await inheritedConfig("devin", workspace, node);
    const hooks = { ...(config.hooks as Record<string, unknown> ?? {}) };
    for (const event of ["SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse", "Stop", "SessionEnd", "PostCompaction"]) {
      hooks[event] = [...(Array.isArray(hooks[event]) ? hooks[event] as unknown[] : []), { hooks: [{ type: "command", command, timeout: hookTimeout }] }];
    }
    files["devin-config.json"] = JSON.stringify({ ...config, hooks });
    args.push("--config", workspace.kind === "ssh" ? `${root}/devin-config.json` : join(root, "devin-config.json"));
  } else {
    const cursor = kind === "cursor";
    files[`${cursor ? ".cursor-plugin" : ".claude-plugin"}/plugin.json`] = JSON.stringify({ name: "que-session-state", version: "1.0.0", description: "Report this Que terminal's lifecycle" });
    const events = cursor
      ? [...CURSOR_HOOK_EVENTS]
      : ["SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse", "PostToolUseFailure", "Stop", "StopFailure"];
    const hooks = Object.fromEntries(events.map(event => [event, cursor
      ? [{ command: commandFor(event), timeout: hookTimeout }]
      : [{ hooks: [{ type: "command", command, timeout: hookTimeout }] }]]));
    // Cursor's TUI only looks at user/project hooks.json before dispatching
    // prompt/stop/response. Keep plugin hooks empty so the helper does not run twice.
    files["hooks/hooks.json"] = JSON.stringify({ ...(cursor ? { version: 1, hooks: {} } : { hooks }) });
    if (cursor) {
      files["cursor-user-hooks.json"] = JSON.stringify({ version: 1, hooks });
      if (workspace.kind === "local") cursorConfigPath = cursorUserHooksPath();
      else files[`cards/${token}/.keep`] = "";
    }
    args.push("--plugin-dir", root);
  }
  if (workspace.kind === "ssh") {
    // Session files stay launch-scoped. Cursor also merges ~/.cursor/hooks.json
    // because its TUI ignores --plugin-dir for prompt/stop/response.
    const payload = Buffer.from(JSON.stringify(files)).toString("base64");
    const installer = 'const fs=require("node:fs"),p=require("node:path"),root=process.argv[1];for(const [name,body] of Object.entries(JSON.parse(Buffer.from(process.argv[2],"base64")))){const f=p.join(root,name);fs.mkdirSync(p.dirname(f),{recursive:true,mode:448});const tmp=f+"."+require("node:crypto").randomUUID()+".tmp";fs.writeFileSync(tmp,body,{mode:384});fs.renameSync(tmp,f);}';
    await sshExec(workspace.sshHost!, [node, "-e", installer, root, payload].map(shellQuote).join(" "));
    if (grokConfigPath) {
      const install = 'const fs=require("node:fs"),p=require("node:path"),src=process.argv[1],dest=process.argv[2];if(fs.existsSync(dest)&&JSON.parse(fs.readFileSync(dest,"utf8")).queManaged!==true)throw Error("Existing hook file is not owned by Que");fs.mkdirSync(p.dirname(dest),{recursive:true,mode:448});fs.copyFileSync(src,dest);fs.chmodSync(dest,384);';
      await sshExec(workspace.sshHost!, [node, "-e", install, `${root}/grok-hooks.json`, grokConfigPath].map(shellQuote).join(" "));
    }
    if (antigravityConfigPath) {
      const installer = 'const fs=require("node:fs"),p=require("node:path"),dest=process.argv[1],src=process.argv[2];const x=fs.existsSync(dest)?JSON.parse(fs.readFileSync(dest,"utf8")):{};if(x["que-session-state"]&&!JSON.stringify(x["que-session-state"]).includes("/que/"))throw Error("Hook name already owned");x["que-session-state"]=JSON.parse(fs.readFileSync(src,"utf8"));fs.mkdirSync(p.dirname(dest),{recursive:true});fs.writeFileSync(dest+".que.tmp",JSON.stringify(x,null,2),{mode:384});fs.renameSync(dest+".que.tmp",dest);';
      await sshExec(workspace.sshHost!, [node, "-e", installer, antigravityConfigPath, `${root}/antigravity-hooks.json`].map(shellQuote).join(" "));
    }
    if (cursorConfigPath) {
      const installer = 'const fs=require("node:fs"),p=require("node:path"),dest=process.argv[1],src=process.argv[2],hook=process.argv[3];const owned=c=>{if(typeof c!=="string")return false;if(c.includes(hook))return true;const m=c.match(/-EncodedCommand\\s+(\\S+)/);if(m){try{const s=Buffer.from(m[1],"base64").toString("utf16le");if(s.includes(hook)||/[\\\\/](?:harness-plugins[\\\\/]cursor|\\.cache[\\\\/]que[\\\\/]harness)[\\\\/].*hook\\.cjs/.test(s))return true;}catch{}}return /[\\\\/](?:harness-plugins[\\\\/]cursor|\\.cache[\\\\/]que[\\\\/]harness)[\\\\/].*hook\\.cjs/.test(c)};const incoming=JSON.parse(fs.readFileSync(src,"utf8"));let x=fs.existsSync(dest)?JSON.parse(fs.readFileSync(dest,"utf8")):{};if(!x||Array.isArray(x)||typeof x!=="object")throw Error("Invalid Cursor hooks configuration");const hooks={...(x.hooks&&typeof x.hooks==="object"&&!Array.isArray(x.hooks)?x.hooks:{})};for(const [event,entries] of Object.entries(incoming.hooks||{})){const cur=Array.isArray(hooks[event])?hooks[event]:[];hooks[event]=[...cur.filter(e=>!owned(e&&e.command)),...entries];}x={...x,version:1,hooks};fs.mkdirSync(p.dirname(dest),{recursive:true,mode:448});fs.writeFileSync(dest+".que.tmp",JSON.stringify(x,null,2),{mode:384});fs.renameSync(dest+".que.tmp",dest);';
      await sshExec(workspace.sshHost!, [node, "-e", installer, cursorConfigPath, `${root}/cursor-user-hooks.json`, hookPath].map(shellQuote).join(" "));
    }
    return { args, env: {
      ...extraEnv,
      QUE_HARNESS_CHANNEL: token,
      QUE_HARNESS_KIND: kind,
      ...(kind === "cursor" ? { QUE_HARNESS_SIGNAL_DIR: `${root}/cards/${token}` } : {}),
    } };
  }
  for (const [name, body] of Object.entries(files)) {
    const path = join(root, name);
    await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
    await writeFile(`${path}.${token}.tmp`, body, { mode: 0o600 });
    await rename(`${path}.${token}.tmp`, path);
  }
  if (antigravityConfigPath) {
    let config: Record<string, unknown> = {};
    try { config = JSON.parse(await readFile(antigravityConfigPath, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (!config || Array.isArray(config) || typeof config !== "object") throw new Error("Invalid Antigravity hooks configuration");
    const existing = config["que-session-state"];
    const owned = (value: unknown): boolean => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const definitions = Object.entries(value).filter(([key]) => key !== "enabled");
      return definitions.length > 0 && definitions.every(([event, entries]) =>
        ["PreInvocation", "PostInvocation", "PreToolUse", "PostToolUse", "Stop"].includes(event)
        && Array.isArray(entries) && entries.length > 0 && entries.every(entry => {
          const handlers = Array.isArray(entry?.hooks) ? entry.hooks : [entry];
          return handlers.length > 0 && handlers.every((handler: { command?: string }) =>
            typeof handler.command === "string" && (handler.command === commandFor(event) || /[\\/]\.que[\\/]harness-plugins[\\/]antigravity[\\/]hook\.cjs["']/.test(handler.command)));
        }));
    };
    if (existing && !owned(existing)) throw new Error("Antigravity hook 同名条目不属于 Que，未覆盖");
    config["que-session-state"] = JSON.parse(files["antigravity-hooks.json"]);
    await mkdir(join(antigravityConfigPath, ".."), { recursive: true, mode: 0o700 });
    await writeFile(`${antigravityConfigPath}.${token}.tmp`, JSON.stringify(config, null, 2), { mode: 0o600 });
    await rename(`${antigravityConfigPath}.${token}.tmp`, antigravityConfigPath);
  }
  if (grokConfigPath) {
    try {
      const existing = JSON.parse(await readFile(grokConfigPath, "utf8"));
      if (existing.queManaged !== true) throw new Error("Grok hook 同名文件不属于 Que，未覆盖");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await mkdir(join(grokConfigPath, ".."), { recursive: true, mode: 0o700 });
    await writeFile(`${grokConfigPath}.${token}.tmp`, files["grok-hooks.json"], { mode: 0o600 });
    await rename(`${grokConfigPath}.${token}.tmp`, grokConfigPath);
  }
  if (cursorConfigPath && files["cursor-user-hooks.json"]) {
    let config: unknown = {};
    try { config = JSON.parse(await readFile(cursorConfigPath, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const merged = mergeCursorUserHooks(config, JSON.parse(files["cursor-user-hooks.json"]), hookPath);
    await mkdir(join(cursorConfigPath, ".."), { recursive: true, mode: 0o700 });
    await writeFile(`${cursorConfigPath}.${token}.tmp`, JSON.stringify(merged, null, 2), { mode: 0o600 });
    await rename(`${cursorConfigPath}.${token}.tmp`, cursorConfigPath);
  }
  return { args, env: { ...extraEnv, QUE_HARNESS_SIGNAL_DIR: directory, QUE_HARNESS_KIND: kind } };
}

export function cursorUserHooksPath(home = homedir()): string {
  return process.env.QUE_CURSOR_HOOKS || join(home, ".cursor", "hooks.json");
}

const QUE_CURSOR_HOOK = /[\\/](?:harness-plugins[\\/]cursor|\.cache[\\/]que[\\/]harness)[\\/].*hook\.cjs/;

export function isQueCursorCommand(command: string, hookPath: string): boolean {
  if (typeof command !== "string") return false;
  if (command.includes(hookPath) || QUE_CURSOR_HOOK.test(command)) return true;
  const encoded = command.match(/-EncodedCommand\s+(\S+)/)?.[1];
  if (!encoded) return false;
  try {
    const script = Buffer.from(encoded, "base64").toString("utf16le");
    return script.includes(hookPath) || QUE_CURSOR_HOOK.test(script);
  } catch { return false; }
}

export function mergeCursorUserHooks(existing: unknown, incoming: { hooks?: Record<string, unknown> }, hookPath: string): Record<string, unknown> {
  if (existing && (typeof existing !== "object" || Array.isArray(existing))) throw new Error("Invalid Cursor hooks configuration");
  const current = existing && typeof existing === "object" ? { ...(existing as Record<string, unknown>) } : {};
  const hooks = current.hooks && typeof current.hooks === "object" && !Array.isArray(current.hooks)
    ? { ...(current.hooks as Record<string, unknown>) } : {};
  for (const [event, entries] of Object.entries(incoming.hooks ?? {})) {
    const previous = Array.isArray(hooks[event]) ? hooks[event] as { command?: string }[] : [];
    hooks[event] = [...previous.filter(entry => !isQueCursorCommand(entry?.command ?? "", hookPath)), ...(Array.isArray(entries) ? entries : [])];
  }
  return { ...current, version: 1, hooks };
}

export function windowsHookCommand(node: string, hook: string, electronNode: boolean, event?: string, extraEnv: Record<string, string> = {}): string {
  const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const invoke = [node, hook, ...(event ? [event] : [])].map(literal).join(" ");
  const cursorReply = extraEnv.QUE_HARNESS_KIND === "cursor" ? cursorHookStdout(event) : undefined;
  // This outer command works in cmd, PowerShell and Git Bash. Keep all paths
  // and optional event arguments inside the encoded script, not shell syntax.
  // Read piped JSON explicitly; native stdin is not forwarded by PowerShell.
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    "[Console]::InputEncoding = $OutputEncoding",
    "[Console]::OutputEncoding = $OutputEncoding",
    ...Object.entries(extraEnv).map(([key, value]) => `$env:${key} = ${literal(value)}`),
    ...(electronNode ? ["$env:ELECTRON_RUN_AS_NODE = '1'"] : []),
    // Answer Cursor before reading stdin. Otherwise a shell worker that waits
    // for hook JSON before closing the pipe deadlocks on ReadToEnd and blocks send.
    ...(cursorReply ? [`[Console]::Out.WriteLine('${cursorReply}')`, "[Console]::Out.Flush()"] : []),
    "$payload = [Console]::In.ReadToEnd()",
    cursorReply ? `$payload | & ${invoke} | Out-Null` : `$payload | & ${invoke}`,
    "exit $LASTEXITCODE",
  ].join("; ");
  return `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;
}
