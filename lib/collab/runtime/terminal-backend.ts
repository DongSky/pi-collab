import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { beginNativeReceipt,type LaunchIdentity } from "./receipts";
import { sessionProcesses } from "./process-session";
import { runnerEnvironment,type WorkspaceLocation } from "./workspace";
import { RpcPeer } from "./rpc-peer";
import { ProcessExitUnconfirmed,nativePiEntry,type RuntimeBackend,type AgentProcess } from "./backends";
export class NativeTerminalBackend implements RuntimeBackend {
 readonly isolation="trusted-local-process" as const;
 async start(workspace:WorkspaceLocation,_model?:{provider:string;id:string},identity?:LaunchIdentity):Promise<AgentProcess>{
  if(!["darwin","linux"].includes(process.platform))throw new Error("terminal_platform_unsupported");
  // Verify session inspection exists before creating a writer.
  await sessionProcesses(process.pid);
  const runtimeEntry=await nativePiEntry();
  const receipt=await beginNativeReceipt(workspace,identity),entry=fileURLToPath(new URL("./terminal-runner.mjs",import.meta.url));
  const child=spawn(process.execPath,[entry],{cwd:workspace.checkout,env:{...runnerEnvironment(workspace.home,workspace.agentDir),...(workspace.port?{PORT:String(workspace.port),PI_COLLAB_PORT:String(workspace.port),HOST:"127.0.0.1"}:{})},stdio:"pipe",detached:true});
  const peer=new RpcPeer(child);let launchingTerminal=false,session:number|undefined,stopWork:Promise<void>|undefined;
  const signalGroup=(group:number,signal:NodeJS.Signals)=>{if(group<2)throw new Error("terminal_process_invalid");try{process.kill(-group,signal);}catch(e){if((e as NodeJS.ErrnoException).code!=="ESRCH")throw e;}};
  const groupAlive=()=>{if(!child.pid)return false;try{process.kill(-child.pid,0);return true;}catch(e){if((e as NodeJS.ErrnoException).code==="ESRCH")return false;throw e;}};
  const stop=()=>stopWork??=(async()=>{
   try {
   for(const signal of ["SIGTERM","SIGKILL"] as const){
    if(session)for(const group of new Set((await sessionProcesses(session)).map(p=>p.group)))signalGroup(group,signal);
    if(child.pid)signalGroup(child.pid,signal);
    const deadline=Date.now()+(signal==="SIGTERM"?2000:2000);
    while(Date.now()<deadline){if(!groupAlive()&&(!session||!(await sessionProcesses(session)).length))break;await new Promise(resolve=>setTimeout(resolve,100));}
    if(!groupAlive()&&(!session||!(await sessionProcesses(session)).length))break;
   }
   if(groupAlive()||session&&(await sessionProcesses(session)).length)throw new ProcessExitUnconfirmed("Terminal session still has processes");
   let timer:ReturnType<typeof setTimeout>|undefined;
   try{if(!await Promise.race([peer.exited.then(()=>true),new Promise<boolean>(resolve=>{timer=setTimeout(()=>resolve(false),1000);})]))throw new ProcessExitUnconfirmed("Terminal streams still open");}finally{clearTimeout(timer);}
   if(launchingTerminal&&!session)throw new ProcessExitUnconfirmed("Terminal launch outcome unknown");
   await receipt.stopped();
   } finally { if(groupAlive()&&child.pid)signalGroup(child.pid,"SIGKILL"); }
  })();
  try{if(child.pid)await receipt.started(child.pid);await peer.command("get_state");}catch(e){await stop();throw e;}
  return{peer,backend:"native",runtimeEntry,stop,startTerminal:async()=>{
   launchingTerminal=true;await receipt.pendingSession();const response=await peer.command("terminal_start");const pid=(response.data as {pid:number}).pid;
   if(!Number.isInteger(pid)||pid<2)throw new ProcessExitUnconfirmed("Terminal process identity unavailable");session=pid;
   if(!(await sessionProcesses(pid)).some(p=>p.pid===pid))throw new ProcessExitUnconfirmed("Terminal session identity unavailable");
   await receipt.started(child.pid!,pid);
  }};
 }
}
