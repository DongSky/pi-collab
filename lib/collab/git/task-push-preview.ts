import { createHash } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { GitHubReadClient } from "./github-client";
import { GitHubError } from "./github-credentials";
import { downloadGitHubGit } from "./github-pack";
import { githubPushBinding } from "./github-task-target";
import { exportTaskPush } from "./task-push-export";
import { inspectWorkspaceGit } from "../runtime/workspace-git-view";
import { sourceSchema } from "./workspace-schema";

export const taskPushPreviewInput = z.object({ version: z.literal(1), exportId: z.uuid(), operationId: z.uuid(), taskId: z.uuid(),
  source: sourceSchema, revision: z.string().regex(/^[a-f0-9]{64}$/), head: z.string().regex(/^[a-f0-9]{40}$/).refine(value => value !== "0".repeat(40)),
  binding: githubPushBinding,
}).strict();
export type TaskPushPreviewInput = z.infer<typeof taskPushPreviewInput>;

/** Internal broker preparation, never a browser-authorized operation by itself.
 * SQL must pin current actor/task/source/binding authority and exclude platform
 * source writers before entry and before publishing the returned record.
 * No caller-provided remote baseline SHA or hash is accepted here. */
export async function createTaskPushPreview(root: string, raw: TaskPushPreviewInput, client: GitHubReadClient, external?: AbortSignal) {
  const input = taskPushPreviewInput.parse(raw), signal = AbortSignal.any([external ?? new AbortController().signal, AbortSignal.timeout(360000)]);
  root = await realpath(root);
  const view = (await inspectWorkspaceGit(root, input.source, signal)).summary();
  if (view.revision !== input.revision || view.head !== input.head) throw new GitHubError("github_push_source_changed");
  const parent = path.join(root, "task-push-captures"); await mkdir(parent, { recursive: true, mode: 0o700 });
  if ((await lstat(parent)).isSymbolicLink()) throw new GitHubError("github_push_path_invalid");
  const scope = { taskId: input.taskId, workspaceId: input.source.workspaceId };
  // Downloads into a new private directory; it never fetches into a running or
  // stopped task, or promotes/mutates the shared local repository baseline.
  const { evidence, target } = await client.readTaskPushTarget(input.binding, scope,
    (observed, read, deadline) => downloadGitHubGit(path.join(parent, input.exportId), observed, read, deadline), signal);
  const observation = { baseline: evidence, target }, observationHash = createHash("sha256").update(JSON.stringify(observation)).digest("hex");
  if (signal.aborted) throw new GitHubError("github_request_cancelled");
  const exported = await exportTaskPush(root, { version: 1, exportId: input.exportId, source: input.source, revision: input.revision,
    intent: { operationId: input.operationId, repositoryId: input.binding.repositoryId, ...scope, expectedOld: target.observedOld, newSha: input.head },
    remoteBaseline: { sha: target.defaultSha, observationHash, captureId: input.exportId },
  }, signal);
  // Durable SQL admission must retain this exact observation/hash and export
  // hash. Neither a local completion file nor these hashes grant write access.
  return { version: 1 as const, input, observation, observationHash, ...exported };
}
