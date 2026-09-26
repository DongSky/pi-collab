import { z } from "zod";
import { asUser } from "../database";
import { workspaceGitInput, workspaceGitActionInput } from "./workspace-schema";
export { workspaceGitInput, workspaceGitActionInput } from "./workspace-schema";
export function requestWorkspaceGit(userId: string, runId: string, raw: z.input<typeof workspaceGitInput>) {
  z.uuid().parse(runId); const { idempotencyKey, ...payload } = workspaceGitInput.parse(raw);
  return asUser(userId, async db => (await db.query("SELECT collab.request_workspace_git($1,$2,$3) AS result", [runId, idempotencyKey, payload])).rows[0].result);
}
export function listWorkspaceGit(userId: string, runId: string) {
  z.uuid().parse(runId);
  return asUser(userId, async db => ({ operations: (await db.query("SELECT collab.workspace_git_operations($1) AS result", [runId])).rows[0].result }));
}
export function workspaceGitAction(userId: string, operationId: string, raw: z.input<typeof workspaceGitActionInput>) {
  z.uuid().parse(operationId); const input = workspaceGitActionInput.parse(raw);
  return asUser(userId, async db => (await db.query("SELECT collab.workspace_git_action($1,$2,$3,$4) AS result", [operationId, input.action, input.reason, input.idempotencyKey])).rows[0].result);
}
