import { open } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ResolutionInput } from "../resolution-schema";
import { checkedCompositionGit, composeIntegrationSources, type CompositionConflict } from "./integration-composition";
import type { IntegrationEvidence } from "../integration-schema";
import { createWorkspace } from "./workspace";
import { canonicalResolutionInput } from "./resolution-inputs";
export { verifyResolutionInputs } from "./resolution-inputs";
import { contractPins, type ContractPin } from "../contract-schema";
import { materializeContractInputs } from "./contract-inputs";

const EVIDENCE_LIMIT = 4 * 1024 * 1024;
async function durable(file: string, bytes: string) {
  const handle = await open(file, "wx", 0o444);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  const directory = await open(path.dirname(file), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

export interface PreparedResolutionEvidence {
  version: 1; status: "requires_resolution"; workspaceId: string; resolutionInputHash: string;
  preparedCommit: string; merges: IntegrationEvidence["merges"]; conflicts: CompositionConflict[];
}

/** Internal, native-only provisioning primitive, not an admission API. The
 * caller must authorize and fence the task before handing this workspace to
 * Pi. Only the resolution-aware executor may dispatch these database pins. */
export async function prepareResolutionWorkspace(root: string, workspaceId: string, raw: ResolutionInput, signal: AbortSignal, options: { contracts?: ContractPin[] } = {}) {
  const { input, bytes, inputHash } = canonicalResolutionInput(raw); z.uuid().parse(workspaceId);
  if (signal.aborted) throw new Error("integration_cancelled");
  const workspace = await createWorkspace(root, workspaceId, path.join(root, "repositories", input.repositoryId, "git"), input.targetSha, true);
  const combined = await composeIntegrationSources(root, workspace.checkout, input, signal, { expectedFailure: { merges: input.merges, conflict: input.conflict } });
  await checkedCompositionGit(workspace.checkout, ["reset", "--hard", combined.current], signal);
  const contracts = contractPins.parse(options.contracts ?? combined.contracts);
  if (combined.contracts.some(pin => !contracts.some(other => JSON.stringify(other) === JSON.stringify(pin)))) throw new Error("integration_contract_mismatch");
  await materializeContractInputs(workspace.root, contracts);
  const evidence: PreparedResolutionEvidence = {
    version: 1, status: "requires_resolution", workspaceId, resolutionInputHash: inputHash,
    preparedCommit: combined.current, merges: combined.merges, conflicts: combined.conflicts,
  };
  const evidenceBytes = JSON.stringify(evidence);
  if (Buffer.byteLength(evidenceBytes) > EVIDENCE_LIMIT) throw new Error("integration_resolution_input_limit");
  await durable(path.join(workspace.root, "resolution-evidence.json"), evidenceBytes);
  // Publish the canonical input last. A partial failed directory must not be
  // reused or treated as a completed preparation on a supervisor restart.
  await durable(path.join(workspace.root, "resolution.json"), bytes);
  return { workspace, input, evidence, contracts };
}
