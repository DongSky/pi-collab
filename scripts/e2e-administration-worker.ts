import {randomBytes,createHash} from "node:crypto";
import {writeFile} from "node:fs/promises";
import path from "node:path";
import {Pool} from "pg";
import {connectionString,localConfig} from "./local-config";
const dbName=process.env.PI_COLLAB_E2E_DATABASE??"",root=process.env.PI_COLLAB_E2E_DATA??"";
if(!/^pi_collab_test_[a-f0-9]+$/.test(dbName)||!path.basename(root).startsWith("identity-e2e-"))throw new Error("Isolated administration fixture required");
const db=new Pool({connectionString:connectionString(await localConfig(),true,dbName)});
try{if(process.argv[2]==="recovery"){
 const token=randomBytes(32).toString("hex");await db.query("SELECT collab_admin.issue_account_recovery($1,$2,$3)",["browser-owner@pi-collab.test",createHash("sha256").update(token).digest("hex"),"Isolated browser owner identity verified by fixture operator"]);await writeFile(path.join(root,"account-recovery.json"),JSON.stringify({token}),{flag:"wx",mode:0o600});console.log(JSON.stringify({issued:true}));
 }else if(process.argv[2]==="quarantine"){
 const run=(await db.query("SELECT r.id,r.workspace_id FROM collab.runs r JOIN public.\"user\" u ON u.id=r.requested_by WHERE u.email='browser-owner@pi-collab.test' AND r.status='completed' ORDER BY r.created_at LIMIT 1")).rows[0];if(!run)throw new Error("Run fixture missing");await db.query("UPDATE collab.runs SET status='reconciling',revision=revision+1 WHERE id=$1",[run.id]);await db.query("UPDATE collab.workspaces SET status='quarantined',epoch=epoch+1 WHERE id=$1",[run.workspace_id]);console.log(JSON.stringify({runId:run.id}));
 }else throw new Error("Unsupported fixture mode");
}finally{await db.end();}
