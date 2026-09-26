import {parseArgs} from "node:util";
import path from "node:path";
import {Pool} from "pg";
import {localConfig,connectionString,dataRoot} from "./local-config";
import {readPrivateGitHubFile,githubMasterKey} from "../lib/collab/git/github-credentials";
import {registerGitLab} from "../lib/collab/gitlab/registration";
const {values}=parseArgs({options:{connection:{type:'string'},version:{type:'string'},project:{type:'string'},actor:{type:'string'},origin:{type:'string'},'remote-id':{type:'string'},name:{type:'string'},'token-file':{type:'string'},reason:{type:'string'}}});
if(!values.project||!values.actor||!values.origin||!values['remote-id']||!values.name||!values['token-file']||!values.reason)throw new Error('Usage: npm run gitlab:connect -- --project UUID --actor EMAIL --origin https://gitlab.example.com --remote-id NUMERIC_ID --name NAME --token-file PRIVATE_FILE --reason TEXT');
if(!!values.connection!==!!values.version)throw new Error('Rotation requires both --connection UUID and --version CURRENT_VERSION');
const admin=new Pool({connectionString:connectionString(await localConfig(),true)});let master:Buffer|undefined,token:Buffer|undefined;
try{const user=(await admin.query('SELECT id FROM public."user" WHERE email=$1',[values.actor.toLowerCase()])).rows[0];if(!user)throw new Error('Local actor not found');token=await readPrivateGitHubFile(values['token-file']);master=await githubMasterKey(path.join(dataRoot,'git-master.key'),true);const result=await registerGitLab(admin,master,{projectId:values.project,actorId:user.id,origin:values.origin,remoteId:values['remote-id'],name:values.name,reason:values.reason},token.toString('utf8').trim(),undefined,values.connection?{connectionId:values.connection,expectedVersion:values.version!}:undefined);console.log(JSON.stringify({connectionId:result.id,project:result.evidence.path,defaultBranch:result.evidence.defaultBranch}));}
catch(e){console.error(e instanceof Error&&/^gitlab_/.test(e.message)?e.message:'GitLab connection was not confirmed; inspect configuration and current access.');process.exitCode=1;}
finally{token?.fill(0);master?.fill(0);await admin.end();}
