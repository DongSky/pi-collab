import { memoryProposal } from "./memory-schema";
import { questionInput } from "./question-schema";
import { subtaskProposal } from "./subtask-schema";
import { z } from "zod";
import { workIntentInput } from "./work-intent-schema";
import { resourceSchemas } from "./resource-schema";
import { proposalInput } from "./contract-schema";
export const sequenceInput = z.string().regex(/^[0-9]{1,18}$/).default("0");
export const noteInput = z.object({
  targetTaskId: z.uuid(), kind: z.enum(["question", "finding", "blocker", "handoff"]), body: z.string().trim().min(1).max(4000),
  resultIds: z.array(z.uuid()).max(8), revisionIds: z.array(z.uuid()).max(8), idempotencyKey: z.uuid(),
}).strict().refine(v => v.resultIds.length + v.revisionIds.length <= 8, "最多引用八个成果或契约版本。");
export const coordinationSchemas = {
  ask_user: questionInput,
  ...resourceSchemas,
  propose_memory: memoryProposal,
  propose_subtask: subtaskProposal,
  get_context: z.object({ afterSequence: sequenceInput }).strict(),
  declare_intent: workIntentInput,
  propose_contract: proposalInput.omit({ repositoryId: true }),
  send_note: noteInput,
};
export type CoordinationMethod = keyof typeof coordinationSchemas;
