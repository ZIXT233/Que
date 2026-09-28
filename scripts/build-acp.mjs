import { build } from 'esbuild';
import { copyFile, stat, readFile } from 'node:fs/promises';
// acpx 0.19.3 prefers resume (no transcript replay) when adopting a native
// session. First import into Flat needs load so acpx stores the replayed messages.
const nativeHistoryReplay = { name: 'native-history-replay', setup(build) {
  build.onLoad({filter: /acpx[\/]dist[\/]runtime\.js$/}, async ({path}) => {
    const source = await readFile(path, 'utf8');
    const before = 'if (client.supportsResumeSession()) {\n\t\t\tconst resumed = await client.resumeSession(resumeSessionId, cwd);';
    if (!source.includes(before)) throw Error('acpx native history seam changed; verify replay before upgrading');
    return {contents: source.replace(before, 'if (client.supportsResumeSession() && !client.supportsLoadSession()) {\n\t\t\tconst resumed = await client.resumeSession(resumeSessionId, cwd);'), loader:'js'};
  });
  build.onLoad({filter: /acpx[\/]dist[\/]queue-owner-runtime-[^/]+\.js$/}, async ({path}) => {
    const source=await readFile(path,'utf8');
    const before='if (params.sameSessionOnly) throw makeSessionResumeRequiredError({\n\t\trecord: params.record,\n\t\treason: loadError,';
    const after=`const missingEmptyRollout = !params.record.importedFrom && !sessionHasAgentMessages(params.record)
      && /^no rollout found for thread id [a-zA-Z0-9-]+$/.test(extractAcpError(error)?.data?.details || "");
    if (params.sameSessionOnly && !missingEmptyRollout) throw makeSessionResumeRequiredError({
        record: params.record,
        reason: loadError,`;
    if(!source.includes(before))throw Error('acpx empty-session recovery seam changed; review before upgrade');
    return {contents:source.replace(before,after),loader:'js'};
  });
}};
await build({ define:{FLAT_MCP_BRIDGE_SOURCE:JSON.stringify(await readFile('scripts/que-mcp.cjs','utf8'))}, plugins:[nativeHistoryReplay], entryPoints: ['runtime/acp-owner.mjs'], outfile: 'src-tauri/resources/bin/flat-acp.mjs', bundle: true, platform: 'node', format: 'esm', target: 'node22', banner: { js: 'import { createRequire as flatCreateRequire } from "node:module";const require=flatCreateRequire(import.meta.url);' } });

// Tauri's existing development executable resolves resources from target/debug.
// Refresh that copy too; a running owner still needs to reconnect to load it.
const debugResources = 'src-tauri/target/debug/resources/bin';
try {
  if ((await stat(debugResources)).isDirectory()) {
    await copyFile('src-tauri/resources/bin/flat-acp.mjs', `${debugResources}/flat-acp.mjs`);
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
