import { build } from 'esbuild';
import { copyFile, stat, readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
// acpx exposes native session discovery only on AcpClient, which lives in an internal
// chunk whose file name and export alias change with every release. Locate both here,
// so an upgrade either keeps working or fails the build with a clear message.
const acpxInternals = { name: 'acpx-internals', setup(build) {
  build.onResolve({filter: /^acpx-internals$/}, () => ({path: 'acpx-internals', namespace: 'acpx-internals'}));
  build.onLoad({filter: /.*/, namespace: 'acpx-internals'}, async () => {
    const dist = path.join(path.dirname(createRequire(import.meta.url).resolve('acpx/package.json')), 'dist');
    const chunks = (await readdir(dist)).filter(name => /^queue-owner-runtime-[\w-]+\.js$/.test(name));
    if (chunks.length !== 1) throw Error(`acpx internals: expected one queue-owner-runtime chunk in ${dist}, found ${chunks.length}; review before upgrading`);
    const alias = (await readFile(path.join(dist, chunks[0]), 'utf8')).match(/\bAcpClient as ([A-Za-z_$][\w$]*)/)?.[1];
    if (!alias) throw Error(`acpx internals: ${chunks[0]} no longer exports AcpClient; native session discovery needs a new seam`);
    return {contents: `export { ${alias} as AcpClient } from ${JSON.stringify(path.join(dist, chunks[0]))};`, loader: 'js', resolveDir: dist};
  });
}};
// acpx 0.19.3 prefers resume (no transcript replay) when adopting a native
// session. First import into Que needs load so acpx stores the replayed messages.
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
await build({ define:{QUE_MCP_BRIDGE_SOURCE:JSON.stringify(await readFile('scripts/que-mcp.cjs','utf8'))}, plugins:[nativeHistoryReplay, acpxInternals], entryPoints: ['runtime/acp-owner.mjs'], outfile: 'src-tauri/resources/bin/acp-owner.mjs', bundle: true, platform: 'node', format: 'esm', target: 'node22', banner: { js: 'import { createRequire as queCreateRequire } from "node:module";const require=queCreateRequire(import.meta.url);' } });

// Tauri's existing development executable resolves resources from target/debug.
// Refresh that copy too; a running owner still needs to reconnect to load it.
const debugResources = 'src-tauri/target/debug/resources/bin';
try {
  if ((await stat(debugResources)).isDirectory()) {
    await copyFile('src-tauri/resources/bin/acp-owner.mjs', `${debugResources}/acp-owner.mjs`);
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
