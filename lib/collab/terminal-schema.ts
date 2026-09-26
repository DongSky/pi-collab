import { z } from "zod";
export const terminalCommand=z.discriminatedUnion("type",[
 z.object({type:z.literal("input"),data:z.string().min(1).max(8192)}).strict(),
 z.object({type:z.literal("resize"),cols:z.number().int().min(20).max(240),rows:z.number().int().min(5).max(100)}).strict(),
]);
export const terminalInput=z.object({expectedVersion:z.string().regex(/^[1-9][0-9]{0,17}$/),idempotencyKey:z.uuid(),command:terminalCommand}).strict();
