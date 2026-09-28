import { DEFAULT_RUNNER_IMAGE } from "./container-image";
import { readFile, writeFile, lstat } from "node:fs/promises";
import { containerBridge, containerRuntime, type ContainerRuntime } from "./container-bridge";
import { beginContainerReceipt, dockerExec } from "./container-receipts";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { RpcPeer } from "./rpc-peer";
import { runnerEnvironment, type WorkspaceLocation } from "./workspace";
import { beginNativeReceipt, type LaunchIdentity } from "./receipts";
import type { CoordinationAccess } from "../coordination-server";

export interface AgentProcess {
  peer: RpcPeer;
  runtimeEntry?: string;
  runtimeEvidence?: ContainerRuntime & {image:string};
  backend: "native" | "docker";
  startTerminal?(): Promise<void>;
  stop(): Promise<void>;
}
export interface RuntimeBackend {
  readonly isolation: "trusted-local-process" | "container";
  start(workspace: WorkspaceLocation, model?: { provider: string; id: string }, identity?: LaunchIdentity, coordination?: CoordinationAccess): Promise<AgentProcess>;
}
export class ProcessExitUnconfirmed extends Error { readonly code = "PI_PROCESS_EXIT_UNCONFIRMED"; }

const piArguments = ["--mode", "rpc", "--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve"];

async function waitForClose(peer: RpcPeer, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([peer.exited.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), ms); })]); }
  finally { if (timer) clearTimeout(timer); }
}

export async function nativePiEntry() { return (await import("./pi-entry.mjs")).piEntry; }

export class NativeRuntimeBackend implements RuntimeBackend {
  readonly isolation = "trusted-local-process" as const;
  async start(workspace: WorkspaceLocation, model?: { provider: string; id: string }, identity?: LaunchIdentity, coordination?: CoordinationAccess): Promise<AgentProcess> {
    const piEntry = await nativePiEntry();
    if(workspace.port) {
      const basePort=workspace.port;
      if(!Number.isInteger(basePort)||basePort<41000||basePort>60999)throw new Error("Invalid workspace port");
      // The database-allocated port may still be held at OS level by a lingering
      // process (e.g. TIME_WAIT or slow cleanup). Probe and fall through to the
      // next free port instead of failing the whole run.
      let allocatedPort: number | null = null;
      for(let attempt=0; attempt<200; attempt++) {
        const candidate = 41000 + ((basePort - 41000 + attempt) % 20000);
        const free = await new Promise<boolean>(resolve=>{
          const probe=createServer();
          probe.once("error",()=>resolve(false));
          probe.listen(candidate,"127.0.0.1",()=>probe.close(error=>resolve(!error)));
        });
        if(free) { allocatedPort=candidate; break; }
      }
      if(allocatedPort===null) throw new Error("workspace_port_occupied");
      workspace.port=allocatedPort;
    }
    const receipt = await beginNativeReceipt(workspace, identity);
    const child = spawn(process.execPath, [piEntry, ...piArguments, ...(coordination ? ["--extension", fileURLToPath(new URL("./coordination-extension.ts", import.meta.url))] : []), ...(model ? ["--provider", model.provider, "--model", model.id, "--thinking", "off"] : [])], {
      cwd: workspace.checkout, env: { ...runnerEnvironment(workspace.home, workspace.agentDir), ...(workspace.port ? { PORT:String(workspace.port),PI_COLLAB_PORT:String(workspace.port),HOST:"127.0.0.1" } : {}), ...(coordination ? { PI_COLLAB_COORDINATION_URL: coordination.url, PI_COLLAB_COORDINATION_TOKEN: coordination.token } : {}) },
      stdio: "pipe", detached: process.platform !== "win32",
    });
    const peer = new RpcPeer(child);
    const signal = (value: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        if (process.platform === "win32") child.kill(value);
        else process.kill(-child.pid, value); // Includes tools spawned in the owned process group.
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    };
    let stopping: Promise<void> | undefined;
    const stop = () => stopping ??= (async () => {
      const groupAlive = () => {
        if (!child.pid || process.platform === "win32") return peer.alive;
        try { process.kill(-child.pid, 0); return true; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
      };
      const waitForGroup = async (ms: number) => {
        const deadline = Date.now() + ms;
        while (groupAlive() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
        return !groupAlive();
      };
      // The parent may already have exited while ordinary descendant tools remain.
      signal("SIGTERM");
      if (!await waitForGroup(4000)) {
        signal("SIGKILL");
        if (!await waitForGroup(2000)) throw new ProcessExitUnconfirmed("Pi process group did not exit; workspace must remain quarantined");
      }
      if (!await waitForClose(peer, 1000)) throw new ProcessExitUnconfirmed("Pi output streams did not close; workspace must remain quarantined");
      await receipt.stopped();
    })();
    try {
      if (child.pid) await receipt.started(child.pid);
      await peer.command("get_state");
    }
    catch (error) { await stop(); throw error; }
    return { peer, backend: "native", runtimeEntry: piEntry, stop };
  }
}

export class DockerRuntimeBackend implements RuntimeBackend {
  readonly isolation = "container" as const;
  constructor(private readonly image = DEFAULT_RUNNER_IMAGE,private readonly kind: "ai"|"terminal"|"preview"="ai") {}
  async start(workspace: WorkspaceLocation, model?: { provider: string; id: string }, identity?: LaunchIdentity, coordination?: CoordinationAccess, beforeReceipt?: () => void): Promise<AgentProcess> {
    const image = (await dockerExec("docker", ["image", "inspect", this.image, "--format", "{{.Id}}"], {timeout:10000})).stdout.trim();
    beforeReceipt?.();
    const receipt = await beginContainerReceipt(workspace,image,identity);
    let gateway: {url:string;token:string}|undefined;
    if(model){
      const file=path.join(workspace.agentDir,"models.json"),config=JSON.parse(await readFile(file,"utf8")),provider=config.providers?.[model.provider];
      const endpoint=new URL(provider?.baseUrl);
      if(!["127.0.0.1","[::1]"].includes(endpoint.hostname)||endpoint.protocol!=="http:"||endpoint.pathname!=="/v1"||endpoint.username||endpoint.password||endpoint.search||endpoint.hash||!/^([a-f0-9]{64})$/.test(provider.apiKey))throw new Error("Invalid container gateway capability");
      gateway={url:provider.baseUrl,token:provider.apiKey};provider.baseUrl="http://127.0.0.1:39871/v1";
      await writeFile(file,JSON.stringify(config),{mode:0o600});
    }
    const mounts:string[]=[];
    for(const name of ["dependencies","contracts.json","resolution.json","resolution-evidence.json","revert.json","revert-conflicts.txt"]){
      try{const source=path.join(workspace.root,name),stat=await lstat(source);if(stat.isSymbolicLink())throw new Error("Container sidecar must not be a symbolic link");mounts.push("--mount",`type=bind,source=${source},target=/work/${name},readonly`);}
      catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
    }
    const args=["create","--init","--pull=never","--name",`pi-collab-${workspace.id}`,"--label",`pi-collab.workspace=${workspace.id}`,"--network=none","--read-only",
      "--cap-drop=ALL","--security-opt=no-new-privileges","--pids-limit=128","--memory=1g","--cpus=1",
      "--user",`${process.getuid?.()??1000}:${process.getgid?.()??1000}`,"--tmpfs","/tmp:rw,nosuid,noexec,size=64m",
      "--mount",`type=bind,source=${workspace.checkout},target=/work/checkout`,"--mount",`type=bind,source=${workspace.agentDir},target=/agent`,
      "--mount",`type=bind,source=${workspace.home},target=/home/agent`,...mounts,
      "-e","HOME=/home/agent","-e","PI_CODING_AGENT_DIR=/agent","-e","PI_OFFLINE=1","-e","PI_TELEMETRY=0",
      "-e","GIT_CONFIG_NOSYSTEM=1","-e","GIT_CONFIG_GLOBAL=/dev/null","-e","GIT_TERMINAL_PROMPT=0",
      ...(workspace.port?["-e",`PORT=${workspace.port}`,"-e",`PI_COLLAB_PORT=${workspace.port}`,"-e","HOST=127.0.0.1"]:[]),
      ...(coordination?["-e","PI_COLLAB_COORDINATION_URL=http://127.0.0.1:39871/v1/coordinate","-e",`PI_COLLAB_COORDINATION_TOKEN=${coordination.token}`]:[]),
      ...(this.kind==="preview"?["-e","PI_COLLAB_SERVICE_CONTAINER=1","-e","PI_COLLAB_NPM_CLI=/usr/local/lib/node_modules/npm/bin/npm-cli.js","-e","npm_config_cache=/home/agent/.npm","-e","npm_config_userconfig=/home/agent/service-user.npmrc","-e","npm_config_globalconfig=/home/agent/service-global.npmrc","-e","npm_config_registry=http://127.0.0.1:39871/registry/","-e","npm_config_update_notifier=false","-e","CI=1"]:[]),
      "-w","/work/checkout","-i",image,...(this.kind==="terminal"?["--collab-terminal"]:this.kind==="preview"?["--collab-preview"]:piArguments),
      ...(coordination?["--extension","/opt/pi/lib/collab/runtime/coordination-extension.ts"]:[]),
      ...(model?["--provider",model.provider,"--model",model.id,"--thinking","off"]:[])];
    let id:string;
    try{id=(await dockerExec("docker",args,{timeout:30000})).stdout.trim();}catch{throw new Error("Container creation failed; inspect the local Docker daemon");}
    await receipt.started(id); // Durable identity exists before docker start can create a writer.
    const child=spawn("docker",["start","-ai",id],{stdio:"pipe"});
    const bridge=containerBridge(child,gateway,coordination);
    let evidence:ContainerRuntime|undefined;
    const peer=new RpcPeer(child,event=>{if(event.type==="collab_runtime"){if(!evidence){const parsed=containerRuntime.safeParse(event.runtime);if(parsed.success)evidence=parsed.data;}return true;}return bridge.accept(event);});
    let stopping:Promise<void>|undefined;
    const stop=()=>stopping??=(async()=>{
      bridge.close();
      await dockerExec("docker",["stop","--time","4",id],{timeout:12000});
      const info=JSON.parse((await dockerExec("docker",["inspect",id],{timeout:10000})).stdout)[0];
      if(info.Id!==id||info.State.Running!==false)throw new ProcessExitUnconfirmed("Container exit unconfirmed");
      if(!await waitForClose(peer,6000))throw new ProcessExitUnconfirmed("Container output streams did not close");
      await receipt.stopped();
      await dockerExec("docker",["rm",id],{timeout:10000});
    })();
    try{await peer.command("get_state");if(!evidence)throw new Error("Container runtime evidence missing");}
    catch(error){await stop();throw error;}
    return {peer,backend:"docker",runtimeEvidence:{...evidence!,image},stop,...(this.kind==="terminal"?{startTerminal:async()=>{await peer.command("terminal_start");}}:{})};
  }
}

export function runtimeBackend(mode = process.env.PI_COLLAB_RUNTIME ?? "native"): RuntimeBackend {
  if (mode === "native") return new NativeRuntimeBackend();
  if (mode === "docker") return new DockerRuntimeBackend();
  throw new Error(`Unknown runtime backend: ${mode}`);
}
