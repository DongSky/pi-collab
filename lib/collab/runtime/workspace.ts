import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, realpath, writeFile, stat, lstat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const exec = promisify(execFile);
export interface WorkspaceLocation {
  port?: number; id: string; root: string; checkout: string; agentDir: string; home: string; baseSha: string; branch: string;
}

export function runnerEnvironment(home: string, agentDir: string): NodeJS.ProcessEnv {
  const environment: Record<string, string> = {
    HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir,
    PI_CODING_AGENT_SESSION_DIR: path.join(agentDir, "sessions"),
    PI_OFFLINE: "1", PI_TELEMETRY: "0",
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    LANG: "en_US.UTF-8", TERM: "dumb", GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
  };
  // Next declares NODE_ENV required on process.env, but a child receives a fresh dictionary.
  return environment as NodeJS.ProcessEnv;
}

/** Internal provisioning input. Routes must pass an authorized broker-owned clone, not a user's path. */
export async function createWorkspace(dataRoot: string, id: string, sourceRepository: string, baseSha?: string, rawCheckout = false): Promise<WorkspaceLocation> {
  z.uuid().parse(id);
  if (baseSha && !/^[a-f0-9]{40}$/.test(baseSha)) throw new Error("baseSha must be a complete commit SHA");
  const source = await realpath(sourceRepository);
  if (!(await stat(source)).isDirectory()) throw new Error("Repository source must be a directory");
  const root = path.resolve(dataRoot, "workspaces", id);
  await mkdir(path.dirname(root), { recursive: true, mode: 0o700 });
  // Never silently reuse a directory that may still have a live writer.
  await mkdir(root, { mode: 0o700 });
  const checkout = path.join(root, "checkout"), home = path.join(root, "home"), agentDir = path.join(root, "agent");
  await Promise.all([home, agentDir].map(dir => mkdir(dir, { mode: 0o700 })));
  const env = runnerEnvironment(home, agentDir);
  const git = (args: string[]) => exec("git", args, { env, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  // --no-local prevents shared object hardlinks/alternates between independent writers.
  await git(["-c", "core.hooksPath=/dev/null", "clone", "--no-local", "--no-checkout", "--", source, checkout]);
  // Browser folder imports store the selected working bytes, rather than Git
  // filter/encoding-normalized blobs. The marker is broker-owned, outside the tree.
  let importedBytes=false;
  try { const marker=await lstat(path.join(source,"pi-collab-folder-import"));if(!marker.isFile()||marker.isSymbolicLink())throw new Error("Invalid folder source marker");importedBytes=true; } catch(error) { if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error; }
  if (rawCheckout || importedBytes) {
    await mkdir(path.join(checkout, ".git", "info"), { recursive: true, mode: 0o700 });
    // Snapshot working files already contain their actual bytes. Prevent a
    // second encoding/EOL/filter conversion while constructing the new clone.
    await writeFile(path.join(checkout, ".git", "info", "attributes"), "* -text -eol -filter -ident -working-tree-encoding\n", { flag: "wx", mode: 0o600 });
  }
  const resolvedBase = (await git(["-C", checkout, "rev-parse", "--verify", `${baseSha ?? "HEAD"}^{commit}`])).stdout.trim();
  const branch = `task/${id}`;
  await git(["-C", checkout, "-c", "core.hooksPath=/dev/null", "checkout", "--no-guess", "-b", branch, resolvedBase]);
  // No remote credentials or push URL belong in an agent-controlled working copy.
  await git(["-C", checkout, "remote", "remove", "origin"]);
  await git(["-C", checkout, "config", "user.name", "pi-collab agent"]);
  await git(["-C", checkout, "config", "user.email", "agent@pi-collab.local"]);
  const workspace = { id, root, checkout, agentDir, home, baseSha: resolvedBase, branch };
  await writeFile(path.join(root, "workspace.json"), JSON.stringify(workspace, null, 2), { mode: 0o600, flag: "wx" });
  return workspace;
}
