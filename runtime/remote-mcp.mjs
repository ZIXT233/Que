import net from 'node:net';
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';

// Separate from the owner's control socket: possessing a per-run capability
// permits only MCP calls for that card, never ACP control operations.
const WAIT_MAX_SECONDS = 120;
/** A tool call gets a few seconds, or the wait it asked for. */
export function callBudget(body, timeoutMs) {
  if (body?.tool !== 'wait_messages') return timeoutMs;
  const seconds = Math.min(Math.max(Number(body.timeoutSeconds) || 50, 1), WAIT_MAX_SECONDS);
  return Math.max(timeoutMs, (seconds + 8) * 1000);
}
export function remoteMcpHub({socketPath, sessions, timeoutMs = 20000}) {
  const routes = new Map(), capabilities = new Map(), pending = new Map(), sockets = new Set();
  const failure = message => ({isError:true,content:[{type:'text',text:message}]});
  const unavailable = 'QueACP connection interrupted; execution may be unknown. No automatic retry was made.';
  function finish(id, result) {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id); clearTimeout(entry.timer);
    if (!entry.socket.destroyed) entry.socket.end(JSON.stringify(result)+'\n');
  }
  function unbind(client) {
    for (const [card, route] of routes) if (route === client) routes.delete(card);
    for (const [id, entry] of pending) if (entry.client === client) finish(id, failure(unavailable));
  }
  function bind(card, client) {
    if (!card || !client || client.destroyed) return;
    const old = routes.get(card);
    if (old && old !== client) {
      for (const [id, entry] of pending) if (entry.card === card) finish(id, failure(unavailable));
    }
    routes.set(card, client);
  }
  function capability(card, epoch) {
    for (const [token, entry] of capabilities) if (entry.card === card) capabilities.delete(token);
    const token = randomUUID();
    capabilities.set(token, {card, epoch, clientId:randomUUID()});
    return token;
  }
  function receive(client, message) {
    const entry = pending.get(message.requestId);
    if (!entry || entry.client !== client) return;
    const session = sessions()[entry.card];
    if (session?.connectionId !== entry.epoch) return finish(message.requestId, failure('Source agent run changed'));
    finish(message.requestId, message.result ?? failure('Invalid MCP response'));
  }
  const server = net.createServer(socket => {
    sockets.add(socket);socket.on('error',()=>{});
    socket.on('close',()=>{
      sockets.delete(socket);
      for (const [id, entry] of pending) if (entry.socket === socket) {clearTimeout(entry.timer);pending.delete(id);}
    });
    let buffer = '', consumed = false;
    socket.setEncoding('utf8');socket.setTimeout(callBudget({tool:'wait_messages',timeoutSeconds:WAIT_MAX_SECONDS},timeoutMs)+1000,()=>socket.destroy());
    socket.on('data', chunk => {
      if (consumed) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 1024*1024) {socket.destroy();return;}
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      consumed = true;
      try {
        const request = JSON.parse(buffer.slice(0,end)), source = capabilities.get(request.capability);
        if (!source) throw Error('Invalid MCP session capability');
        const {card, epoch, clientId} = source, session = sessions()[card], client = routes.get(card);
        if (session?.connectionId !== epoch || !['working','attention','starting'].includes(session.state)) throw Error('Source agent run ended or changed');
        if (!client || client.destroyed) throw Error(unavailable);
        if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body) || typeof request.body.tool !== 'string') throw Error('Invalid MCP request');
        if (pending.size >= 128) throw Error('Too many pending MCP calls');
        const id = randomUUID();
        const timer = setTimeout(()=>finish(id,failure('QueACP tool request timed out; execution may be unknown. No automatic retry was made.')),callBudget(request.body,timeoutMs));
        pending.set(id,{socket,client,card,epoch,timer});
        client.write(JSON.stringify({event:'mcp_request',requestId:id,cardId:card,epoch,clientId,body:request.body})+'\n');
      } catch (error) {socket.end(JSON.stringify(failure(error.message))+'\n');}
    });
  });
  return {
    bind, unbind, capability, receive,
    async listen() {
      await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,resolve);});
      if (process.platform !== 'win32') fs.chmodSync(socketPath,0o600);
    },
    async close() {
      for (const id of pending.keys()) finish(id,failure(unavailable));
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve=>server.close(resolve));
    },
  };
}
