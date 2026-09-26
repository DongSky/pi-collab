import path from "node:path";
import { writeFile } from "node:fs/promises";
import { z } from "zod";
import { checkedCompositionGit, compositionGit } from "./integration-composition";
import type { WorkspaceLocation } from "./workspace";
const sha = z.string().regex(/^[a-f0-9]{40}$/);
export const revertInputSchema = z.object({ version: z.literal(1), taskId: z.uuid(), repositoryId: z.uuid(), promotionId: z.uuid(), targetSha: sha, oldSha: sha, newSha: sha }).strict();
export type RevertInput = z.infer<typeof revertInputSchema>;
/** Only called before an agent enters a newly created checkout. The inverse is
 * the whole promotion delta, not its empty provenance-only final commit. */
export async function prepareRevert(workspace: WorkspaceLocation, raw: RevertInput, signal: AbortSignal) {
  const input = revertInputSchema.parse(raw), cwd = workspace.checkout;
  if (workspace.baseSha !== input.targetSha) throw new Error("revert_source_unavailable");
  await checkedCompositionGit(cwd, ["merge-base", "--is-ancestor", input.newSha, input.targetSha], signal);
  await checkedCompositionGit(cwd, ["merge-base", "--is-ancestor", input.oldSha, input.newSha], signal);
  const oldTree = sha.parse((await checkedCompositionGit(cwd, ["rev-parse", `${input.oldSha}^{tree}`], signal)).toString().trim());
  const inverse = sha.parse((await checkedCompositionGit(cwd, ["commit-tree", oldTree, "-p", input.newSha], signal, `Revert pi-collab promotion ${input.promotionId}\n\n${JSON.stringify(input)}\n`)).toString().trim());
  // Git's three-way merge preserves later unrelated work and materializes
  // textual/binary conflict evidence rather than silently taking the old tree.
  const result = await compositionGit(cwd, ["merge-tree", "--write-tree", "--messages", "-z", input.targetSha, inverse], signal);
  if (![0, 1].includes(result.code)) throw new Error("revert_prepare_failed");
  const tree = sha.parse(result.stdout.subarray(0, result.stdout.indexOf(0)).toString());
  const commit = sha.parse((await checkedCompositionGit(cwd, ["commit-tree", tree, "-p", input.targetSha], signal,
    `Revert pi-collab promotion ${input.promotionId}\n\n${JSON.stringify({ ...input, requiresResolution: result.code === 1 })}\n`)).toString().trim());
  // This reset only installs the generated commit in the new private checkout.
  await checkedCompositionGit(cwd, ["reset", "--hard", commit], signal);
  await writeFile(path.join(workspace.root, "revert.json"), JSON.stringify({ ...input, preparedCommit: commit, requiresResolution: result.code === 1 }), { flag: "wx", mode: 0o444 });
  await writeFile(path.join(workspace.root, "revert-conflicts.txt"), result.stdout, { flag: "wx", mode: 0o444 });
  return { commit, requiresResolution: result.code === 1 };
}
