import path from "node:path";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { mkdir, cp } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PoolClient } from "pg";
import { asUser } from "./database";
import { projectRole, uuid } from "./projects";
import { DomainError } from "./policy";

import { runInput } from "./run-schema";
export { runInput } from "./run-schema";
export const stopInput = z.object({ idempotencyKey: uuid, controlVersion: z.string().regex(/^[1-9][0-9]{0,17}$/).optional() }).strict();
export interface AcceptedCommand { commandId: string; runId: string; status: string; replayed: boolean }

const exec = promisify(execFile);

/**
 * Simplification: import a local working directory as a repository on-the-fly.
 * Codex/Cursor-style: user provides a directory path, we handle the repository
 * bookkeeping automatically instead of requiring a pre-imported repositoryId.
 */
async function ensureLocalRepository(
  db: PoolClient,
  userId: string,
  projectId: string,
  workingDirectory: string,
  baseSha?: string,
): Promise<{ repositoryId: string; baseSha: string }> {
  const absPath = path.resolve(workingDirectory);
  // Verify it's a directory with a git repo (or at least exists)
  let resolvedSha = baseSha;
  if (!resolvedSha) {
    try {
      const { stdout } = await exec("git", ["-C", absPath, "rev-parse", "HEAD"], { timeout: 10000 });
      resolvedSha = stdout.trim();
    } catch {
      throw new DomainError("invalid_working_directory", `工作目录不是有效的 Git 仓库: ${absPath}`, 400);
    }
  }
  if (!/^[a-f0-9]{40}$/.test(resolvedSha)) {
    throw new DomainError("invalid_base_sha", "baseSha 必须是完整的 40 位 commit SHA", 400);
  }

  // Check if we already imported this path (by name convention)
  const dirName = path.basename(absPath);
  const existing = await db.query(
    "SELECT id, base_sha FROM collab.repositories WHERE project_id=$1 AND name=$2 AND provider='local' ORDER BY created_at DESC LIMIT 1",
    [projectId, dirName]
  );
  if (existing.rows[0]) {
    return { repositoryId: String(existing.rows[0].id), baseSha: resolvedSha };
  }

  // Create new repository record
  const repositoryId = randomUUID();
  const dataRoot = path.resolve(process.env.PI_COLLAB_DATA_DIR ?? ".local");
  const repoPath = path.join(dataRoot, "repositories", repositoryId, "git");

  await projectRole(db, projectId, "task.create");
  await db.query(
    "INSERT INTO collab.repositories (id, organization_id, project_id, name, provider, base_sha, default_branch) " +
    "SELECT $1, organization_id, $2, $3, 'local', $4, 'main' FROM collab.projects WHERE id=$2",
    [repositoryId, projectId, dirName.slice(0, 120), resolvedSha]
  );

  // Copy the working directory to the managed location
  await mkdir(path.dirname(repoPath), { recursive: true, mode: 0o700 });
  await cp(absPath, repoPath, { recursive: true, filter: (src) => !src.includes("/.git/") || src.endsWith("/.git") });

  // Ensure it's a valid git repo at the managed location
  try {
    await exec("git", ["-C", repoPath, "rev-parse", "HEAD"], { timeout: 10000 });
  } catch {
    // If copy didn't preserve .git, init it
    await exec("git", ["-C", repoPath, "init", "-q"], { timeout: 10000 });
    await exec("git", ["-C", repoPath, "add", "-A"], { timeout: 10000 });
    await exec("git", ["-C", repoPath, "-c", "user.name=pi-collab", "-c", "user.email=agent@pi-collab.local", "commit", "-qm", "import"], { timeout: 10000 });
    const { stdout } = await exec("git", ["-C", repoPath, "rev-parse", "HEAD"], { timeout: 10000 });
    resolvedSha = stdout.trim();
    await db.query("UPDATE collab.repositories SET base_sha=$1 WHERE id=$2", [resolvedSha, repositoryId]);
  }

  return { repositoryId, baseSha: resolvedSha };
}

export function startRun(userId: string, taskId: string, raw: z.input<typeof runInput>): Promise<AcceptedCommand> {
  uuid.parse(taskId); const input = runInput.parse(raw);
  return asUser(userId, async db => {
    let repositoryId = input.repositoryId;
    let baseSha = input.baseSha;
    const task = (await db.query("SELECT project_id FROM collab.tasks WHERE id=$1", [taskId])).rows[0];
    if (!task) throw new DomainError("not_found", "任务不存在或不可访问。", 404);
    const projectId = String(task.project_id);
    // Simplification: workingDirectory → auto-import as repository
    if (input.workingDirectory) {
      const imported = await ensureLocalRepository(db, userId, projectId, input.workingDirectory, baseSha);
      repositoryId = imported.repositoryId;
      baseSha = imported.baseSha;
    }
    // Cursor-style: if the project has a bound local directory, use it by default
    if (!repositoryId) {
      const binding = (await db.query("SELECT local_path FROM collab.project_local_bindings WHERE project_id=$1", [projectId])).rows[0];
      if (binding) {
        const imported = await ensureLocalRepository(db, userId, projectId, String(binding.local_path), baseSha);
        repositoryId = imported.repositoryId;
        baseSha = imported.baseSha;
      }
    }
    if (!repositoryId || !baseSha) throw new DomainError("invalid_input", "需要提供 repositoryId、workingDirectory，或为项目绑定本地目录", 400);
    return (await db.query("SELECT collab.submit_work_run($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) AS result", [taskId, repositoryId, baseSha, input.prompt, process.env.PI_COLLAB_RUNTIME ?? "native", input.idempotencyKey, input.expectedVersion, input.modelProfileId ?? null, input.snapshotId ?? null, input.suggestionId ?? null, input.editorVersionId ?? null, input.executionKind])).rows[0].result;
  });
}
export function stopRun(userId: string, runId: string, raw: z.infer<typeof stopInput>): Promise<AcceptedCommand> {
  uuid.parse(runId); const input = stopInput.parse(raw);
  return asUser(userId, async db => (await db.query("SELECT collab.stop_run($1,$2,$3) AS result", [runId, input.idempotencyKey, input.controlVersion ?? null])).rows[0].result);
}
export function listRepositories(userId: string, projectId: string) {
  uuid.parse(projectId);
  return asUser(userId, async db => {
    await projectRole(db, projectId, "project.read");
    return { repositories: (await db.query("SELECT repo.id,repo.name,repo.provider,repo.base_sha,repo.default_branch,CASE WHEN b.repository_id IS NULL THEN NULL ELSE jsonb_build_object('repositoryId',b.github_repository_id,'owner',b.evidence->>'ownerLogin','name',b.evidence->>'name','url',b.evidence->>'htmlUrl','targetSha',b.evidence->>'targetSha','defaultBranch',b.evidence->>'defaultBranch','verifiedAt',b.verified_at,'state',collab.github_binding_state(repo.id)) END AS github FROM collab.repositories repo LEFT JOIN collab.github_bindings b ON b.repository_id=repo.id WHERE repo.project_id=$1 ORDER BY repo.created_at", [projectId])).rows };
  });
}
export function listRuns(userId: string, taskId: string) {
  uuid.parse(taskId);
  return asUser(userId, async db => {
    const task = (await db.query("SELECT project_id FROM collab.tasks WHERE id=$1", [taskId])).rows[0];
    if (!task) throw new DomainError("not_found", "任务不存在或不可访问。", 404);
    await projectRole(db, task.project_id, "project.read");
    return { runs: (await db.query(`SELECT r.id,r.execution_kind,r.task_id,r.workspace_id,r.requested_by,r.prompt,r.status,r.revision,r.stop_reason,r.summary,r.created_at,r.started_at,r.finished_at,
      w.repository_id,w.status AS workspace_status,w.archived_at,w.retain_until,collab.run_dependency_state(r.id) AS dependency_state,collab.control_state(r.id) AS control,
      (SELECT jsonb_build_object('id',a.id,'kind',a.kind,'status',a.status,'code',a.result_code) FROM collab.run_actions a WHERE a.run_id=r.id ORDER BY a.created_at DESC,a.id DESC LIMIT 1) AS latest_action
      FROM collab.runs r JOIN collab.workspaces w ON w.id=r.workspace_id WHERE r.task_id=$1 ORDER BY r.created_at DESC LIMIT 50`, [taskId])).rows };
  });
}
export function runTranscript(userId: string, runId: string) {
  uuid.parse(runId);
  return asUser(userId, async db => {
    const run = (await db.query("SELECT project_id FROM collab.runs WHERE id=$1", [runId])).rows[0];
    if (!run) throw new DomainError("not_found", "运行不存在或不可访问。", 404);
    const cursor: string = (await db.query("SELECT event_sequence FROM collab.projects WHERE id=$1", [run.project_id])).rows[0].event_sequence;
    const rows = (await db.query("SELECT sequence,payload FROM collab.run_events WHERE run_id=$1 AND kind='run.output' AND sequence<=$2 ORDER BY sequence DESC LIMIT 101", [runId, cursor])).rows;
    return { cursor, batches: rows.slice(0, 100).reverse(), truncated: rows.length > 100 };
  });
}
export function runDetail(userId: string, runId: string) {
  uuid.parse(runId);
  return asUser(userId, async db => {
    const run = (await db.query("SELECT id,execution_kind,project_id,task_id,workspace_id,requested_by,prompt,status,revision,stop_reason,summary,created_at,started_at,finished_at FROM collab.runs WHERE id=$1", [runId])).rows[0];
    if (!run) throw new DomainError("not_found", "运行不存在或不可访问。", 404);
    const workspace = (await db.query("SELECT id,runtime,status,base_sha,archived_at,retain_until FROM collab.workspaces WHERE id=$1", [run.workspace_id])).rows[0];
    if(workspace)workspace.directory=workspace.runtime==="docker"?"/work/checkout":path.resolve(process.env.PI_COLLAB_DATA_DIR??".local","workspaces",workspace.id,"checkout");
    const commands = (await db.query("SELECT id,kind,status,created_at,updated_at FROM collab.commands WHERE run_id=$1 ORDER BY created_at", [runId])).rows;
    const actions = (await db.query("SELECT id,kind,status,payload,result_code,created_at,finished_at FROM collab.run_actions WHERE run_id=$1 ORDER BY created_at DESC LIMIT 50", [runId])).rows;
    const control = (await db.query("SELECT collab.control_state($1) AS control", [runId])).rows[0].control;
    return { run, workspace, commands, actions, control };
  });
}

export async function runFeed(userId: string, projectId: string, after = "0") {
  uuid.parse(projectId);
  if (!/^\d{1,19}$/.test(after) || BigInt(after) > BigInt("9223372036854775807")) throw new DomainError("invalid_cursor", "无效的事件游标。");
  return asUser(userId, async db => {
    await projectRole(db, projectId, "project.read");
    const authorization = (await db.query("SELECT pm.authorization_version::text AS project,m.authorization_version::text AS organization FROM collab.project_memberships pm JOIN collab.memberships m ON m.organization_id=pm.organization_id AND m.user_id=pm.user_id WHERE pm.project_id=$1 AND pm.user_id=$2 AND pm.active AND m.active", [projectId, userId])).rows[0];
    if (!authorization) throw new DomainError("not_found", "Project not found", 404);
    const authorizationVersion = `${authorization.organization}:${authorization.project}`;
    const head: string = (await db.query("SELECT event_sequence FROM collab.projects WHERE id=$1", [projectId])).rows[0].event_sequence;
    const earliest: string | null = (await db.query("SELECT min(sequence) AS earliest FROM (SELECT sequence FROM collab.run_events WHERE project_id=$1 UNION ALL SELECT sequence FROM collab.repository_baselines WHERE project_id=$1) project_events", [projectId])).rows[0].earliest;
    const reset = BigInt(after) > BigInt(head) || (earliest !== null && BigInt(after) < BigInt(earliest)-BigInt(1));
    if (reset) return {
      reset: true, cursor: head, events: [], authorizationVersion,
      snapshot: (await db.query("SELECT id,task_id,workspace_id,requested_by,status,revision,stop_reason FROM collab.runs WHERE project_id=$1 ORDER BY created_at DESC", [projectId])).rows,
    };
    const events = (await db.query("SELECT * FROM (SELECT sequence,run_id,kind,payload,created_at FROM collab.run_events WHERE project_id=$1 AND sequence>$2 AND sequence<=$3 UNION ALL SELECT sequence,NULL::uuid AS run_id,'repository.baseline_changed' AS kind,jsonb_build_object('repositoryId',repository_id,'promotionId',promotion_id,'syncId',sync_id,'targetBranch',target_branch,'oldSha',old_sha,'newSha',new_sha) AS payload,created_at FROM collab.repository_baselines WHERE project_id=$1 AND sequence>$2 AND sequence<=$3) project_events ORDER BY sequence LIMIT 100", [projectId, after, head])).rows;
    return { reset: false, cursor: events.at(-1)?.sequence ?? after, events, snapshot: null, authorizationVersion };
  });
}
