import { z } from "zod";
import { runInput } from "./run-schema";
const id = z.uuid().or(z.literal(""));
export const runComposerDraft = z.object({
  version: z.literal(1), prompt: z.string().max(20000), executionKind: z.enum(["ai", "terminal"]),
  repositoryId: id, modelId: id, snapshotId: id, suggestionId: id, editorVersionId: id,
}).strict();
export type RunComposerDraft = z.infer<typeof runComposerDraft>;
export function runDraftKeys(userId: string, projectId: string, taskId: string) {
  const scope = JSON.stringify([userId, projectId, taskId]);
  return { composer: `pi-collab:run-composer:v1:${scope}`, pending: `pi-collab:run-request:v1:${scope}` };
}
export function readRunDraft(storage: Pick<Storage, "getItem">, keys: ReturnType<typeof runDraftKeys>) {
  const composer = storage.getItem(keys.composer), pending = storage.getItem(keys.pending);
  if ((composer?.length ?? 0) > 131072 || (pending?.length ?? 0) > 131072) throw new Error("运行草稿超出本窗口上限，请先核对已有运行。");
  return { composer: composer ? runComposerDraft.parse(JSON.parse(composer)) : null, pending: pending ? runInput.parse(JSON.parse(pending)) : null };
}
export function saveRunRequest(storage: Pick<Storage, "setItem" | "removeItem">, key: string, value: z.input<typeof runInput> | null) {
  if (value) storage.setItem(key, JSON.stringify(runInput.parse(value)));
  else storage.removeItem(key);
}
