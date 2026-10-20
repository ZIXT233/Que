import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {sessionEnvironment} from '../../runtime/session-environment.mjs';
const run = promisify(execFile);

test('machine RC applies overrides before sourcing and preserves Codex aliases and argv', {skip:process.platform==='win32'}, async()=>{
  const root=mkdtempSync(path.join(os.tmpdir(), 'que-rc-'));
  try {
    const terminalRc=`echo 'startup banner'; export QUE_RC_VALUE="$QUE_TEST_INPUT/from-rc"; tcodex() { printf '%s\\n' "$QUE_RC_VALUE" "$@"; }; alias codex=tcodex`;
    const options={root,cwd:root,shell:'/bin/bash',terminalRc,env:{QUE_TEST_INPUT:'configured'}};
    const env=await sessionEnvironment(options);
    assert.equal(env.QUE_RC_VALUE,'configured/from-rc');
    assert.ok(env.CODEX_PATH);
    const result=await run(env.CODEX_PATH,['app-server',"a b'c",'$(echo unsafe)'],{env});
    assert.equal(result.stdout,"configured/from-rc\napp-server\na b'c\n$(echo unsafe)\n");
    assert.match(result.stderr,/startup banner/,'RC output stays off the protocol stream');
    assert.equal(process.env.QUE_RC_VALUE,undefined,'owner environment stays isolated');
    const next=await sessionEnvironment({...options,env:{QUE_TEST_INPUT:'updated'}});
    assert.equal(next.QUE_RC_VALUE,'updated/from-rc');
    const defaults=await sessionEnvironment({...options,terminalRc:'export QUE_TEST=ok'});
    assert.equal(defaults.CODEX_PATH,process.env.CODEX_PATH,'no alias preserves the bundled Codex default');
    const explicit=await sessionEnvironment({...options,env:{CODEX_PATH:'/custom/codex'}});
    assert.equal(explicit.CODEX_PATH,'/custom/codex');
    assert.equal((await sessionEnvironment({root,cwd:root,env:{CODEX_HOME:'$HOME/.test-codex'}})).CODEX_HOME,path.join(os.homedir(),'.test-codex'));
    await assert.rejects(sessionEnvironment({...options,terminalRc:'echo private-value; return 1'}),error=>/启动脚本/.test(error.message)&&!error.message.includes('private-value'));
  } finally {rmSync(root,{recursive:true,force:true});}
});
