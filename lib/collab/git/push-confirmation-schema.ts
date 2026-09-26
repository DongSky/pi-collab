import { z } from "zod";
import type { PushDeliveryRecord } from "./push-delivery-schema";
import { githubId, githubBranch, repositoryResponse } from "./github-schema";
const hash = z.string().regex(/^[a-f0-9]{64}$/), sha = z.string().regex(/^[a-f0-9]{40}$/);
const repository = z.object({ repositoryId: z.uuid(), githubRepositoryId: githubId, nodeId: repositoryResponse.shape.node_id,
  ownerId: githubId, ownerLogin: repositoryResponse.shape.owner.shape.login, name: repositoryResponse.shape.name,
  defaultBranch: githubBranch, private: z.boolean(), visibility: z.enum(["public", "private", "internal"]), integrationBranches: z.array(githubBranch).min(1).max(20),
}).strict();
export const pushConfirmationScope = z.object({ manifestHash: hash, observationHash: hash,
  destination: z.object({ repository, ref: z.string().max(250), expectedOld: sha.nullable(), newSha: sha, baseline: sha }).strict(),
  commits: z.array(z.object({ oid: sha, hash, changedPaths: z.number().int().min(0).max(10000) }).strict()).min(1).max(1000),
}).strict();
export const pushConfirmationRequest = pushConfirmationScope.extend({ idempotencyKey: z.uuid(), acknowledgeHistory: z.literal(true),
  acknowledgeDestination: z.literal(true), acknowledgeDisclosure: z.literal(true) }).strict();
export const pushConfirmationWithdrawal = z.object({ idempotencyKey: z.uuid(), reason: z.string().trim().min(10).max(2000) }).strict();
export type PushConfirmationScope = z.infer<typeof pushConfirmationScope>;
export type PushConfirmationRecord = { id: string; previewId: string; actorId: string; status: "reserved" | "withdrawn" | "consumed" | "quarantined"; manifestHash: string; delivery: PushDeliveryRecord | null;
  valid: boolean; createdAt: string; withdrawnAt: string | null; destination: PushConfirmationScope["destination"]; commitCount: number };
export type PushConfirmationContext = { scope: PushConfirmationScope | null; canConfirm: boolean; canWithdraw: boolean; occupied: boolean; confirmations: PushConfirmationRecord[] };
