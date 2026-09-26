import { z } from "zod";

export const dependencyPin = z.object({
  taskId: z.uuid(), kind: z.enum(["strict", "soft"]), resultId: z.uuid().nullable(), snapshotId: z.uuid().nullable(),
  manifestHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(), worktreeCommit: z.string().regex(/^[a-f0-9]{40}$/).nullable(),
}).strict().refine(value => value.resultId ? !!value.snapshotId && !!value.manifestHash && !!value.worktreeCommit : !value.snapshotId && !value.manifestHash && !value.worktreeCommit);
export const dependencyPins = z.array(dependencyPin).max(32).refine(values => new Set(values.map(value => value.taskId)).size === values.length);
export type DependencyPin = z.infer<typeof dependencyPin>;
