import {parseArgs} from "node:util";
import {randomBytes,createHash} from "node:crypto";
import {open} from "node:fs/promises";
import path from "node:path";
import {Pool} from "pg";
import {z} from "zod";
import {localConfig,connectionString} from "./local-config";
const {values}=parseArgs({options:{email:{type:"string"},reason:{type:"string"},output:{type:"string"},"identity-verified":{type:"boolean"}}});
if(!values["identity-verified"]||!values.email||!values.reason||!values.output)throw new Error("Usage: npm run account:recover -- --email EMAIL --reason 'identity verification record, at least 10 characters' --output /private/recovery.txt --identity-verified. Requires trusted host administrator access; changes no account until the ticket is redeemed.");
const email=z.email().parse(values.email).toLowerCase(),reason=z.string().trim().min(10).max(2000).parse(values.reason),file=path.resolve(values.output);
const config=await localConfig(),db=new Pool({connectionString:connectionString(config,true)}),token=randomBytes(32).toString("hex");
const output=await open(file,"wx",0o600);
try{const ticket=(await db.query("SELECT collab_admin.issue_account_recovery($1,$2,$3) AS result",[email,createHash("sha256").update(token).digest("hex"),reason])).rows[0].result;
 const base=process.env.BETTER_AUTH_URL??`http://127.0.0.1:${config.port}`;await output.writeFile(`pi-collab account recovery\nExpires: ${ticket.expiresAt}\n${base}/account-recovery#token=${token}\n`);await output.sync();console.log(`Recovery ticket written to ${file}; deliver it privately to the verified account holder. It expires in 30 minutes and replaces previous tickets.`);
}finally{await output.close();await db.end();}
