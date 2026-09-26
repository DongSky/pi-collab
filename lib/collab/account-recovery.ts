import { z } from "zod";
import { hashPassword } from "better-auth/crypto";
import { database } from "./database";
import { tokenHash } from "./onboarding";
import { DomainError } from "./policy";
export const accountRecoveryInput=z.object({token:z.string().regex(/^[a-f0-9]{64}$/),password:z.string().min(12).max(128)}).strict();
export async function redeemAccountRecovery(raw:unknown){const input=accountRecoveryInput.parse(raw),db=database();
 if(!(await db.query("SELECT collab.allow_public_attempt('account-recovery',8,60) AS allowed")).rows[0].allowed)throw new DomainError("rate_limited","恢复尝试过多，请稍后重试。",429);
 const digest=tokenHash(input.token);if(!(await db.query("SELECT collab.account_recovery_valid($1) AS valid",[digest])).rows[0].valid)throw new DomainError("account_recovery_unavailable","恢复凭证无效、已使用或已到期。",409);
 return (await db.query("SELECT collab.redeem_account_recovery($1,$2) AS result",[digest,await hashPassword(input.password)])).rows[0].result;
}
