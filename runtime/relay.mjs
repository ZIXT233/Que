import net from 'node:net';

/**
 * Pipes stdio to a running `--serve` owner. Exit 3: no owner is running.
 * Exit 4: an idle owner of another build was stopped; start this build instead.
 * A busy owner of another build keeps serving until a later reconnect finds it idle.
 */
export async function relay({ socketPath, build, wait }) {
  let socket;
  for (let attempt = 0; !socket; attempt++) {
    try { socket = await new Promise((resolve, reject) => { const s = net.createConnection(socketPath); s.once('connect', () => resolve(s)); s.once('error', reject); }); }
    catch (error) {
      if (!wait || attempt >= 100) { process.stderr.write(`no owner at ${socketPath}: ${error.code}\n`); process.exit(3); }
      await new Promise(r => setTimeout(r, 100));
    }
  }
  socket.write(JSON.stringify({ action: '_hello', rpc: '_relay' }) + '\n');
  let buffered = '', hello;
  socket.setEncoding('utf8');
  await new Promise(resolve => {
    const read = chunk => {
      buffered += chunk;
      const lines = buffered.split('\n'); buffered = lines.pop();
      for (const line of lines) {
        let value; try { value = JSON.parse(line); } catch {}
        if (value?.rpc === '_relay') hello = value.result; else process.stdout.write(line + '\n');
      }
      if (hello) { socket.off('data', read); socket.off('close', lost); resolve(); }
    };
    const lost = () => process.exit(1);
    socket.on('data', read);
    socket.once('close', lost);
  });
  if (hello.build !== build && !hello.busy) {
    socket.write(JSON.stringify({ action: '_shutdown' }) + '\n');
    socket.once('close', () => process.exit(4));
    return new Promise(() => {});
  }
  if (buffered) process.stdout.write(buffered);
  process.stdin.pipe(socket); socket.pipe(process.stdout);
  socket.once('close', () => process.exit(0));
  return new Promise(() => {});
}
