import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Node cannot import TypeScript directly; bundle the modules under test first.
const dir = await mkdtemp(path.join(tmpdir(), 'que-labels-'));
const { outputFiles: [bundle] } = await build({ bundle: true, format: 'esm', platform: 'node', write: false, stdin: { resolveDir: process.cwd(), contents: `
  export { acpChoiceLabel, acpOptionLabel, acpStartupLabel } from './src/lib/acp-labels.ts';
  export { zhCNLocale } from './src/lib/i18n/messages/zh-CN.ts';
  export { enLocale } from './src/lib/i18n/messages/en.ts';
  export { zhTWLocale } from './src/lib/i18n/messages/zh-TW.ts';` } });
await writeFile(path.join(dir, 'labels.mjs'), bundle.text);
const { acpChoiceLabel, acpOptionLabel, acpStartupLabel, zhCNLocale, enLocale, zhTWLocale } = await import(pathToFileURL(path.join(dir, 'labels.mjs')).href);
await rm(dir, { recursive: true, force: true });

test('agent controls follow UI locale without renaming models or custom values', () => {
 const t = key => zhCNLocale.messages[key] || key;
 assert.equal(acpChoiceLabel({ category:'mode',name:'Mode' }, 'Approve for me', t), 'Approve for me');
 assert.equal(acpChoiceLabel({ category:'thought_level',name:'Thinking' }, 'High', t), '高');
 assert.equal(acpOptionLabel({ category:'mode',name:'Mode' }, t), '权限模式');
 assert.equal(acpChoiceLabel({ category:'model',name:'Model' }, '6 Sol', t), '6 Sol');
 assert.equal(acpChoiceLabel({ category:'model',name:'Model' }, 'High', t), 'High');
 assert.equal(acpChoiceLabel({ category:'mode',name:'Mode' }, 'Provider custom mode', t), 'Provider custom mode');
 assert.equal(acpStartupLabel('正在连接并恢复会话', t), '建立会话连接');
 for (const locale of [enLocale,zhTWLocale]) {
   for (const key of Object.keys(zhCNLocale.messages).filter(k=>k.startsWith('acp.'))) assert.ok(locale.messages[key], `${locale.id}: ${key}`);
 }
});
