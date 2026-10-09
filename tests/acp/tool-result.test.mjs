import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

test('ACP tool envelopes render readable results and preserve unknown formats', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'queacp-tool-render-'));
  try {
    const result = await build({ stdin: { contents: `
      import React from 'react';
      import { renderToStaticMarkup } from 'react-dom/server';
      import { I18nProvider } from './src/hooks/useI18n';
      import { AcpToolResult } from './src/components/AcpToolResult';
      export const render = block => renderToStaticMarkup(<I18nProvider><AcpToolResult block={block}/></I18nProvider>);
    `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, platform: 'node', format: 'esm', banner: { js: "import {createRequire} from 'node:module'; const require=createRequire(import.meta.url);" }, jsx: 'automatic' });
    const entry = join(dir, 'render.mjs');
    await writeFile(entry, result.outputFiles[0].text);
    const { render } = await import(pathToFileURL(entry));
    const html = render({title:'Read file', status:'completed', content:[
      {type:'content',content:{type:'text',text:'**Readable result**'}},
      {type:'diff',path:'src/example.ts',oldText:'const a = 1;',newText:'const a = 2;'},
      {type:'content',content:{type:'resource',resource:{uri:'file:///tmp/test',text:'<script>unsafe()</script>'}}},
      {type:'content',content:{type:'resource_link',uri:'javascript:alert(1)',name:'unsafe link'}},
      {type:'future-format',data:42},
    ]});
    assert.match(html, /<strong>Readable result<\/strong>/);
    assert.match(html, /src\/example.ts/);
    assert.match(html, /data-kind="remove"/);
    assert.match(html, /data-kind="add"/);
    assert.match(html, /const a = 2;/);
    assert.match(html, /&lt;script&gt;/);
    assert.doesNotMatch(html, /href="javascript:/);
    assert.match(html, /Technical details/);
    assert.match(html, /future-format/);
    assert.match(render({rawOutput:'plain terminal output'}), /<pre>plain terminal output<\/pre>/);
    assert.match(render({content:[{type:'terminal',terminalId:'t1'}]}), /not provided by the runtime/);
  } finally { await rm(dir, {recursive:true, force:true}); }
});
