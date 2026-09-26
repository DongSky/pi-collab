import { randomBytes } from "node:crypto";
import path from "node:path";
import { Pool } from "pg";
import { localConfig, connectionString } from "./local-config";
import { registerModelProfile } from "../lib/collab/gateway/profiles";
const dbName=process.env.PI_COLLAB_E2E_DATABASE??"",root=process.env.PI_COLLAB_E2E_DATA??"";
if(!/^pi_collab_test_[a-f0-9]+$/.test(dbName)||!path.basename(root).startsWith("identity-e2e-"))throw new Error("Isolated browser fixture required");
const admin=new Pool({connectionString:connectionString(await localConfig(),true,dbName)});
try{
 const projectId=process.argv[2],p=(await admin.query("SELECT created_by FROM collab.projects WHERE id=$1",[projectId])).rows[0];
 const model=await registerModelProfile(admin,randomBytes(32),{projectId,actorId:p.created_by,name:"Browser priced model",modelId:"fixture-model"},{apiKey:randomBytes(32).toString("hex"),baseUrl:"http://127.0.0.1:9/v1"});
 console.log(JSON.stringify({modelId:model.id}));
}finally{await admin.end();}
