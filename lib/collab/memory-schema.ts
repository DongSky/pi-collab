import {z} from 'zod';
export const memoryProposal=z.object({key:z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),title:z.string().trim().min(1).max(160),kind:z.enum(['decision','contract','lesson','verification']),body:z.string().trim().min(1).max(6000),sourceNote:z.string().trim().min(10).max(2000),parentId:z.uuid().nullable(),idempotencyKey:z.uuid()}).strict();
export const humanMemoryProposal=memoryProposal.extend({repositoryId:z.uuid(),baseSha:z.string().regex(/^[a-f0-9]{40}$/).nullable(),sourceRunId:z.uuid().nullable(),copiedFromId:z.uuid().nullable()});
export const memoryDecision=z.object({expectedRevision:z.number().int().positive(),bodyHash:z.string().regex(/^[a-f0-9]{64}$/),decision:z.enum(['approve','reject','revoke']),note:z.string().trim().min(10).max(2000)}).strict();
