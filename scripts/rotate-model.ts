import {parseArgs} from "node:util";
import path from "node:path";
import {Pool} from "pg";
import {readPrivateGitHubFile} from "../lib/collab/git/github-credentials";
import {masterKey} from "../lib/collab/gateway/credentials";
import {rotateModelCredential} from "../lib/collab/gateway/rotate";
import {localConfig,connectionString,dataRoot} from "./local-config";
const {values}=parseArgs({options:{profile:{type:"string"},actor:{type:"string"},"expected-version":{type:"string"},reason:{type:"string"},"credential-file":{type:"string"}}});
if(!values.profile||!values.actor||!values.reason||!values["expected-version"]||!values["credential-file"])throw new Error('Usage: npm run model:rotate -- --profile UUID --actor EMAIL --expected-version N --reason TEXT --credential-file /private/model.json (0600 JSON with apiKey and baseUrl).');
const db=new Pool({connectionString:connectionString(await localConfig(),true)});let bytes:Buffer|undefined,key:Buffer|undefined;
try{bytes=await readPrivateGitHubFile(values["credential-file"]);const secret=JSON.parse(bytes.toString());bytes.fill(0);key=await masterKey(path.join(dataRoot,"model-master.key"));const actor=(await db.query('SELECT id FROM public."user" WHERE email=$1',[values.actor.toLowerCase()])).rows[0];if(!actor)throw new Error("Maintainer account not found");console.log(JSON.stringify(await rotateModelCredential(db,key,{profileId:values.profile,actorId:actor.id,expectedVersion:Number(values["expected-version"]),reason:values.reason},secret)));}finally{bytes?.fill(0);key?.fill(0);await db.end();}
