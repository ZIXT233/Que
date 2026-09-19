// Actual installed TUI/user profile; change only this invocation's Que hooks.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const entry = process.argv[2];
if (!entry) throw new Error('Pass the installed codex.js entrypoint');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'que-codex-mcp-'));
const plugin = path.join(root, 'harness-plugins', 'codex');
fs.mkdirSync(plugin, { recursive: true });
for (const [source, target] of [['harness-hook.cjs', 'hook.cjs'], ['harness-codex-mcp.cjs', 'codex-mcp.cjs']]) fs.copyFileSync(path.join(__dirname, '../../src-tauri/resources/bin', source), path.join(plugin, target));
const q = JSON.stringify;
const internal = !process.argv.includes('--external');
const forwarded = ['QUE_HARNESS_SIGNAL_DIR','QUE_HARNESS_CHANNEL','QUE_HARNESS_KIND','QUE_HARNESS_TTY','QUE_HARNESS_TMUX_SESSION','TMUX','QUE_EXTERNAL_SIGNAL_DIR','QUE_HOOK_DEBUG','QUE_HOOK_DEBUG_FILE'];
const nativeIndex = process.argv.indexOf('--native');
const native = nativeIndex >= 0 ? path.resolve(process.argv[nativeIndex+1]) : null;
const args = [entry, '--enable', 'hooks', '--dangerously-bypass-hook-trust', '-c', `mcp_servers.que_session_state={command=${q(native || process.execPath)},args=[${q(native ? "codex-mcp" : path.join(plugin, 'codex-mcp.cjs'))}],env_vars=${q(forwarded)}}`];
for (const event of internal ? ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'Stop'] : []) {
  let fields = `que_scope="${internal ? "internal" : "external"}",session_id="\${session_id}",cwd="\${cwd}"`;
  if (event === 'UserPromptSubmit') fields += ',prompt="${prompt}"';
  if (['PreToolUse', 'PermissionRequest', 'PostToolUse'].includes(event)) fields += ',tool_name="${tool_name}"';
  if (event === 'Stop') fields += ',last_assistant_message="${last_assistant_message}"';
  args.push('-c', `hooks.${event}=[{hooks=[{type="mcp_tool",server="que_session_state",tool="session_state",input={hook_event_name="${event}",${fields}},timeout=5}]}]`);
}
console.log('MCP hook evidence: ' + root);
const env = { ...process.env };
delete env.QUE_HARNESS_CHANNEL; delete env.QUE_HARNESS_SIGNAL_DIR;
env.QUE_EXTERNAL_SIGNAL_DIR = path.join(root, 'external-signals');
env.QUE_HOOK_DEBUG = '1'; env.QUE_HOOK_DEBUG_FILE = path.join(root, 'hook-debug.jsonl');
if (internal) env.QUE_HARNESS_SIGNAL_DIR = path.join(root, 'internal-signals');
const child = spawn(process.execPath, args, { env, stdio: 'inherit', windowsHide: true });
child.on('exit', code => {
  const sink = path.join(root, internal ? 'internal-signals' : 'external-signals');
  const signals = fs.existsSync(sink) ? fs.readdirSync(sink).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(sink, f), 'utf8'))) : [];
  const counts = Object.fromEntries(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'].map(event => [event, signals.filter(s => s.event === event).length]));
  const turnsIndex = process.argv.indexOf('--turns');
  const turns = turnsIndex < 0 ? 1 : Number(process.argv[turnsIndex + 1]);
  const wrongSink = path.join(root, internal ? 'external-signals' : 'internal-signals');
  const passed = code === 0 && counts.SessionStart === 1 && counts.UserPromptSubmit === turns && counts.Stop === turns && counts.PreToolUse === turns && counts.PostToolUse === turns && (!fs.existsSync(wrongSink) || fs.readdirSync(wrongSink).length === 0);
  const result = { passed, internal, counts, sessionId: signals[0]?.sessionId, root };
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  process.exitCode = passed ? 0 : 1;
});
