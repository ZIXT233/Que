import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { createAgentRegistry } from 'acpx/runtime';

test('every acpx agent in the picker has a name and an icon', async () => {
  const out = await build({ stdin: { contents: `export { harnessName, providerIconId } from './src/lib/harness/catalog';`, resolveDir: process.cwd(), loader: 'ts' },
    bundle: true, write: false, platform: 'node', format: 'esm', alias: { '@': './src' } });
  const { harnessName, providerIconId } = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'));
  const symbols = new Set([...(await readFile('public/provider-icons.svg', 'utf8')).matchAll(/<symbol id="([^"]+)"/g)].map(m => m[1]));
  const icons = await readFile('src/components/ProviderIcon.tsx', 'utf8');
  for (const agent of createAgentRegistry({}).list()) {
    const icon = providerIconId(agent);
    assert.ok(new RegExp(`^\\s*"?${icon}"?: \\{ symbol: "([^"]+)"`, 'm').test(icons), `${agent}: no icon entry for ${icon}`);
    const symbol = icons.match(new RegExp(`^\\s*"?${icon}"?: \\{ symbol: "([^"]+)"`, 'm'))[1];
    assert.ok(symbols.has(symbol), `${agent}: sprite has no ${symbol}`);
    assert.ok(harnessName(agent), `${agent}: no name`);
  }
});
