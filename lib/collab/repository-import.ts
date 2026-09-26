import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";
import { z } from "zod";
import { runnerEnvironment } from "./runtime/workspace";

const exec = promisify(execFile);
/** Local administrator CLI only. Never expose this filesystem import to an HTTP route. */
export async function importLocalRepository(admin: Pool, root: string, input: { projectId: string; actorId: string; source: string; name: string }) {
  z.uuid().parse(input.projectId); z.string().trim().min(1).max(120).parse(input.name);
  const client = await admin.connect();
  const id = randomUUID(), directory = path.resolve(root, "repositories", id);
  let created = false;
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('collab.user_id',$1,true)", [input.actorId]);
    const { rows } = await client.query("SELECT p.organization_id FROM collab.projects p WHERE p.id=$1 AND collab.project_role(p.id)='maintainer'", [input.projectId]);
    if (!rows.length) throw new Error("Repository registration requires an active project maintainer identity");
    const source = await realpath(input.source);
    await mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
    await mkdir(directory, { mode: 0o700 }); created = true;
    const home = path.join(directory, "broker-home"); await mkdir(home, { mode: 0o700 });
    const env = runnerEnvironment(home, path.join(home, "agent-disabled"));
    const git = (args: string[]) => exec("git", ["-c", "core.hooksPath=/dev/null", "-c", "uploadpack.packObjectsHook=", ...args], { env, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
    const destination = path.join(directory, "git");
    await git(["clone", "--bare", "--no-local", "--", source, destination]);
    const baseSha = (await git(["-C", destination, "rev-parse", "--verify", "HEAD^{commit}"])).stdout.trim();
    const defaultBranch = (await git(["-C", destination, "symbolic-ref", "--short", "HEAD"])).stdout.trim();
    await git(["-C", destination, "remote", "remove", "origin"]);
    await client.query("INSERT INTO collab.repositories(id,organization_id,project_id,name,provider,base_sha,default_branch) VALUES($1,$2,$3,$4,'local',$5,$6)", [id, rows[0].organization_id, input.projectId, input.name, baseSha, defaultBranch]);
    await client.query("INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES($1,$2,$3,'repository.registered',$4,$5)", [rows[0].organization_id, input.projectId, input.actorId, id, { source: "local-administrator-cli", baseSha }]);
    await client.query("COMMIT");
    return { id, baseSha, defaultBranch };
  } catch (error) {
    await client.query("ROLLBACK");
    if (created) await rm(directory, { recursive: true, force: true });
    throw error;
  } finally { client.release(); }
}
