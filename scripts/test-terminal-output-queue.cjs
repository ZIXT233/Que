const fs = require('node:fs');
const assert = require('node:assert/strict');
const test = require('node:test');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, filename);
const { TerminalOutputQueue } = require('../src/lib/terminal-output-queue.ts');
const { Terminal } = require('@xterm/xterm');

test('preserves reset and incremental catch-up boundaries, order and disposal', () => {
  const writes = []; let next;
  const q = new TerminalOutputQueue((batch, done) => { writes.push(batch); next = done; }, 8);
  const items = [{data:'a'}, {data:'b'}, {data:'c'}, {data:'reset',reset:true}, {data:'d'}, {data:'catchup',reset:false}, {data:'e'}];
  items.forEach(item => q.enqueue(item));
  while (writes.flat().length < items.length) next();
  assert.deepEqual(writes.flat(), items);
  assert.deepEqual(writes.map(b => b.map(i => i.data).join('')), ['a','bc','reset','d','catchup','e']);
  q.enqueue({data:'discard'}); q.dispose(); next();
  assert.equal(writes.length, 6);
});

test('real xterm: burst batching preserves parsed screen and reduces async writes', async () => {
  const stream = '\x1b[?1049h' + Array.from({length:2500}, (_,i) => `\x1b[32mhistory ${i} 中文\x1b[0m\r\n`).join('') + '\x1b[Hfinal';
  const chunks = Array.from({length:Math.ceil(stream.length/511)}, (_,i) => stream.slice(i*511,(i+1)*511));
  async function run(batched) {
    const term = new Terminal({cols:85,rows:37,allowProposedApi:true});
    let writes=0; const at=performance.now();
    if (batched) await new Promise(resolve => {
      let parsed=0;
      const q = new TerminalOutputQueue((batch, done) => {
        writes++;
        term.write(batch.map(i=>i.data).join(''), () => { parsed += batch.length; done(); if(parsed===chunks.length) resolve(); });
      });
      chunks.forEach(data=>q.enqueue({data}));
    });
    else for(const chunk of chunks) { writes++; await new Promise(resolve=>term.write(chunk,resolve)); }
    const ms=performance.now()-at;
    const b=term.buffer.active;
    const screen=Array.from({length:b.length},(_,i)=>b.getLine(i).translateToString());
    const cursor=[b.cursorX,b.cursorY]; term.dispose(); return {screen,cursor,writes,ms};
  }
  const serial=await run(false), batch=await run(true);
  assert.deepEqual(batch.screen,serial.screen); assert.deepEqual(batch.cursor,serial.cursor);
  assert(batch.writes < serial.writes / 10);
  console.log(JSON.stringify({serialWrites:serial.writes,batchWrites:batch.writes,serialMs:Math.round(serial.ms),batchMs:Math.round(batch.ms)}));
});
