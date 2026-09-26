import { z } from "zod";
const decimal = z.string().regex(/^(0|[1-9][0-9]{0,6})(\.[0-9]{1,8})?$/);
export const capacityInput = z.object({
 expectedVersion: z.number().int().nonnegative(), idempotencyKey: z.uuid(), reason: z.string().trim().min(10).max(2000),
 projectRuns: z.number().int().min(1).max(32), memberRuns: z.number().int().min(1).max(16),
 dailyTokens: z.number().int().min(1024).max(1000000000), dailyUsd: decimal.refine(v => Number(v)>0 && Number(v)<=1000000).nullable(),
 prices: z.array(z.object({profileId:z.uuid(),inputUsdPerMillion:decimal.refine(v=>Number(v)<=100000),outputUsdPerMillion:decimal.refine(v=>Number(v)<=100000),source:z.string().trim().min(3).max(500)}).strict()).max(100)
}).strict().refine(v=>new Set(v.prices.map(p=>p.profileId)).size===v.prices.length,{message:"同一模型只能填写一份价格"});
