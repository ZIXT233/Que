import {test} from 'node:test';
import assert from 'node:assert/strict';
import {projectRecord,turnReceipt} from '../../runtime/session-history.mjs';

test('replayed messages are history, uncertain local receipts stay uncertain',()=>{
 const record={messages:[{User:{id:'u',content:[{Text:'question'}]}},{Agent:{content:[{Text:'reply'}]}}]};
 const [history]=projectRecord(record);
 assert.equal(history.state,'history');
 assert.equal(history.blocks[0].text,'reply');
 assert.equal(projectRecord(record,[{id:'r',messageId:'u',state:'failed'}])[0].state,'failed');
 assert.equal(projectRecord(record,[{id:'r',messageId:'u',state:'unknown',fingerprint:'submitted'}])[0].state,'unknown');
 assert.equal(projectRecord(record,[{id:'old-import',messageId:'u',state:'unknown'}])[0].state,'history');
 assert.equal(projectRecord(record,[{id:'unconfirmed'}])[1].state,'unknown');
 assert.equal(projectRecord({messages:[{Agent:{content:[{Text:'reply'}]}}]})[0].state,'history');
});

test('canonical message replacement preserves the original input as a fallback receipt',()=>{
 const turn={id:'request',messageId:'old-user-id',text:'keep this input',attachments:[{mediaType:'text/plain',data:'file',name:'test.txt'}],state:'unknown',fingerprint:'known'};
 assert.equal(turnReceipt(turn,new Set(['old-user-id'])).pending,undefined);
 const receipt=turnReceipt(turn,new Set(['new-user-id']));
 assert.equal(receipt.pending.text,turn.text);
 const restored=projectRecord({messages:[]},[receipt])[0];
 assert.equal(restored.text,turn.text);assert.deepEqual(restored.attachments,turn.attachments);assert.equal(restored.state,'unknown');
});
