import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash, randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const execute = promisify(execFile);
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const psQuote = value => `'${value.replaceAll("'", "''")}'`;

// Runs on the target host. Never change the owner's process.env: different
// cards may have different settings, and reconnect must use the latest values.
export async function sessionEnvironment({root, cwd, env = {}, terminalRc = '', shell = process.env.SHELL || '/bin/bash'}) {
  const overrides = Object.fromEntries(Object.entries(env).map(([key, value]) => [key,
    typeof value === 'string' ? value.replace(/^(?:\$HOME|\$\{HOME\}|~)\//, `${os.homedir()}/`) : value]));
  const inherited = {...process.env, ...overrides};
  if (!terminalRc.trim()) return overrides;
  const windows = process.platform === 'win32';
  const directory = path.join(root, 'launch', createHash('sha256').update(JSON.stringify([cwd, terminalRc, shell])).digest('hex'));
  fs.mkdirSync(directory, {recursive:true, mode:0o700});
  const rcPath = path.join(directory, windows ? 'rc.ps1' : 'rc.sh');
  fs.writeFileSync(rcPath, terminalRc, {mode:0o600});
  const marker = `FLAT_ENV_${randomUUID()}`;
  const dump = `process.stdout.write(${JSON.stringify(marker)}+JSON.stringify({env:process.env,customCodex:process.env.FLAT_CUSTOM_CODEX==='1'})+${JSON.stringify(marker)})`;
  let program, args;
  if (windows) {
    program = 'powershell.exe';
    args = ['-NoLogo', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; Set-Location -LiteralPath ${psQuote(cwd)}; . ${psQuote(rcPath)}; $c=Get-Command codex -ErrorAction SilentlyContinue; if ($c.CommandType -in @('Alias','Function')) {$env:FLAT_CUSTOM_CODEX='1'}; & ${psQuote(process.execPath)} -e ${psQuote(dump)}`];
  } else {
    program = shell;
    args = ['-ilc', `cd ${quote(cwd)} || exit $?\n. ${quote(rcPath)} || exit $?\nif alias codex >/dev/null 2>&1 || typeset -f codex >/dev/null 2>&1; then export FLAT_CUSTOM_CODEX=1; else unset FLAT_CUSTOM_CODEX; fi\n${quote(process.execPath)} -e ${quote(dump)}`];
  }
  let output;
  try {
    output = await execute(program, args, {cwd, env:inherited, timeout:15000, maxBuffer:4*1024*1024, windowsHide:true});
  } catch {
    // Do not include RC output or the exec command: either can contain secrets.
    throw Error('机器启动脚本执行失败或超时，请在机器设置中验证 RC');
  }
  const start = output.stdout.indexOf(marker), end = output.stdout.indexOf(marker, start + marker.length);
  if (start < 0 || end < 0) throw Error('机器启动脚本没有返回环境，请检查 RC 是否提前退出');
  const result = JSON.parse(output.stdout.slice(start + marker.length, end));
  delete result.env.FLAT_CUSTOM_CODEX;
  // codex-acp otherwise launches its bundled Codex and bypasses shell aliases.
  // Keep that default unless the user actually configured an alias/function.
  if (result.customCodex && !overrides.CODEX_PATH) {
    const wrapper = path.join(directory, windows ? 'codex.cmd' : 'codex');
    if (windows) {
      const script = path.join(directory, 'codex.ps1');
      fs.writeFileSync(script, `$ErrorActionPreference='Stop'\nSet-Location -LiteralPath ${psQuote(cwd)}\n. ${psQuote(rcPath)}\n& codex @args\nexit $LASTEXITCODE\n`, {mode:0o600});
      fs.writeFileSync(wrapper, `@echo off\r\npowershell.exe -NoLogo -NonInteractive -File "${script}" %*\r\n`, {mode:0o700});
    } else {
      const ready = `FLAT_CODEX_${randomUUID()}`;
      const command = `cd ${quote(cwd)} || exit $?\nif [ -n "\${BASH_VERSION:-}" ]; then shopt -s expand_aliases; elif [ -n "\${ZSH_VERSION:-}" ]; then setopt aliases; fi\n. ${quote(rcPath)} || exit $?\nprintf ${quote(ready)}\neval 'codex "$@"'`;
      // Login scripts can close inherited descriptors and print banners. Strip
      // only the pre-start output; after the marker, forward protocol bytes as-is.
      fs.writeFileSync(wrapper, `#!${process.execPath}
const {spawn}=require('node:child_process');
const child=spawn(${JSON.stringify(shell)},['-ilc',${JSON.stringify(command)},'flat-codex',...process.argv.slice(2)],{stdio:['pipe','pipe','inherit']});
const marker=Buffer.from(${JSON.stringify(ready)});let pending=Buffer.alloc(0),started=false;
process.stdin.pipe(child.stdin);child.stdin.on('error',()=>{});
child.stdout.on('data',chunk=>{if(started){process.stdout.write(chunk);return;}pending=Buffer.concat([pending,chunk]);const at=pending.indexOf(marker);if(at>=0){process.stderr.write(pending.subarray(0,at));process.stdout.write(pending.subarray(at+marker.length));pending=Buffer.alloc(0);started=true;}else if(pending.length>marker.length){const end=pending.length-marker.length;process.stderr.write(pending.subarray(0,end));pending=pending.subarray(end);}});
for(const signal of ['SIGTERM','SIGINT','SIGHUP'])process.on(signal,()=>child.kill(signal));
child.on('error',()=>{process.stderr.write('Unable to start configured Codex shell\\n');process.exit(1);});
child.on('close',(code)=>{if(!started)process.stderr.write(pending);process.exit(code??1);});
`, {mode:0o700});
    }
    result.env.CODEX_PATH = wrapper;
  }
  return result.env;
}
