import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acpChoiceLabel, acpOptionLabel, acpStartupLabel } from '../../src/lib/acp-labels.ts';
import { zhCNLocale } from '../../src/lib/i18n/messages/zh-CN.ts';
import { enLocale } from '../../src/lib/i18n/messages/en.ts';
import { zhTWLocale } from '../../src/lib/i18n/messages/zh-TW.ts';

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
