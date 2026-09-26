import { z } from "zod";
export const questionInput = z.object({ question: z.string().trim().min(1).max(4000), choices: z.array(z.string().trim().min(1).max(200)).max(6).default([]), idempotencyKey: z.uuid() }).strict();
export const answerInput = z.object({ expectedVersion: z.string().regex(/^[1-9][0-9]{0,17}$/), answer: z.string().trim().min(1).max(10000), idempotencyKey: z.uuid() }).strict();
