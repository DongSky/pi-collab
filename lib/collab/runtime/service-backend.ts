import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { findNodeCliScript } from "../../node-cli";
import { beginNativeReceipt, type LaunchIdentity } from "./receipts";
import { sessionProcesses } from "./process-session";
import { runnerEnvironment, type WorkspaceLocation } from "./workspace";
import { RpcPeer } from "./rpc-peer";
import { DockerRuntimeBackend, ProcessExitUnconfirmed, type AgentProcess } from "./backends";
export async function startServiceBackend(workspace: WorkspaceLocation, identity: LaunchIdentity, runtime: "native" | "docker", beforeReceipt: () => void): Promise<AgentProcess> {
  if (runtime === "docker") return new DockerRuntimeBackend(undefined, "preview").start(workspace, undefined, identity, undefined, beforeReceipt);
  await sessionProcesses(process.pid);
  const npm = findNodeCliScript("npm"); if (!npm) throw new Error("service_npm_unavailable");
  beforeReceipt();
  const receipt = await beginNativeReceipt(workspace, identity);
  const child = spawn(process.execPath, [fileURLToPath(new URL("./service-runner.mjs", import.meta.url))], { cwd: workspace.checkout, detached: true, stdio: "pipe", env: {
    ...runnerEnvironment(workspace.home, workspace.agentDir), PORT: String(workspace.port), HOST: "127.0.0.1", CI: "1", PI_COLLAB_NPM_CLI: npm,
    npm_config_cache: path.join(workspace.home, ".npm"), npm_config_userconfig: path.join(workspace.home, "service-user.npmrc"), npm_config_globalconfig: path.join(workspace.home, "service-global.npmrc"), npm_config_registry: "https://registry.npmjs.org", npm_config_update_notifier: "false",
  } });
  const peer = new RpcPeer(child); let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= (async () => {
    if (child.pid) {
      for (const signal of ["SIGTERM", "SIGKILL"] as const) {
        for (const group of new Set((await sessionProcesses(child.pid)).map(p => p.group))) {
          try { process.kill(-group, signal); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e; }
        }
        const deadline = Date.now() + 2500;
        while ((await sessionProcesses(child.pid)).length && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));
        if (!(await sessionProcesses(child.pid)).length) break;
      }
      if ((await sessionProcesses(child.pid)).length) throw new ProcessExitUnconfirmed("Service process session still alive");
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { if (!await Promise.race([peer.exited.then(() => true), new Promise<boolean>(r => { timer = setTimeout(() => r(false), 1000); })])) throw new ProcessExitUnconfirmed("Service streams still open"); } finally { clearTimeout(timer); }
    await receipt.stopped();
  })();
  try { if (child.pid) await receipt.started(child.pid, child.pid); await peer.command("get_state"); } catch (e) { await stop(); throw e; }
  return { peer, stop, backend: "native" };
}
