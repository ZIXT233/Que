// acpx 0.19.3 exposes discovery on its client, not its public embedded runtime.
// Keep this version-pinned seam isolated; the build and fixture test verify it.
import { Y as AcpClient } from 'acpx/dist/queue-owner-runtime-Dhr4gxNE.js';

export async function discoverSessions({registry,agent,cwd,filterCwd=cwd,cursor,env={}}) {
  if (!registry.list().includes(agent)) throw Error('Unknown agent');
  const command=registry.resolve(agent);
  const client=new AcpClient({agentCommand:Array.isArray(command)?command[0]:command,agentArgv:Array.isArray(command)?command:undefined,agentProcessEnv:env,cwd,permissionMode:'deny-all',nonInteractivePermissions:'deny',fs:false,terminal:false});
  const timer=setTimeout(()=>void client.close(),15000);
  try {
    await client.start();
    if (!client.supportsListSessions()) return {supported:false,sessions:[]};
    const page=await client.listSessions({...filterCwd?{cwd:filterCwd}:{},...cursor?{cursor}:{}});
    return {supported:true,...page};
  } finally {clearTimeout(timer);await client.close();}
}
