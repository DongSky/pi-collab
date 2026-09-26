import {createHash} from "node:crypto";
import {constants} from "node:fs";
import {open,lstat,readFile} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {findNodeCliScript} from "../../node-cli";
import type {AgentProcess} from "./backends";
import type {WorkspaceLocation} from "./workspace";
import type {ExecutionStore} from "../execution-store";
import type {ClaimedRun} from "../execution-store";
const sha=(bytes:Buffer)=>createHash("sha256").update(bytes).digest("hex");
const quote=(value:string)=>"'"+value.replace(/'/g,"'\\''")+"'";
async function fileHash(file:string){const f=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);try{const s=await f.stat();if(!s.isFile()||s.size>4*1024*1024)throw new Error("environment_dependency_file_invalid");return sha(await f.readFile());}finally{await f.close();}}
export async function setupRunEnvironment(store:ExecutionStore,executor:string,claim:ClaimedRun,workspace:WorkspaceLocation,agent:AgentProcess){
 const env=await store.environmentSetup(executor,claim.run.id,claim.run.epoch),recipe=env.recipe;
 const npm=findNodeCliScript("npm");
 const runtime=agent.backend==="docker"?agent.runtimeEvidence!:{node:process.version,nodeHash:sha(await readFile(process.execPath)),npmHash:npm?sha(await readFile(npm)):null,piHash:agent.runtimeEntry?sha(await readFile(agent.runtimeEntry)):null,platform:process.platform,arch:process.arch,kernel:os.release(),backend:agent.backend};
 const dependencies:{path:string;hash:string}[]=[];
 try{
  const expected=recipe.requiredRuntime;if(expected?.image&&agent.runtimeEvidence?.image!==expected.image)throw new Error("environment_runtime_mismatch");if(expected)for(const field of ["node","nodeHash","npmHash","piHash","platform","arch","backend"] as const){if(expected[field]!==runtime[field])throw new Error("environment_runtime_mismatch");}
  for(const name of ["package.json","package-lock.json","npm-shrinkwrap.json","yarn.lock","pnpm-lock.yaml","requirements.txt","poetry.lock","uv.lock","Cargo.lock","go.sum"]){try{dependencies.push({path:name,hash:await fileHash(path.join(workspace.checkout,name))});}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}}
  if(recipe.install==="npm-ci"){
   if(agent.backend==="native"&&!npm)throw new Error("environment_installer_unavailable");
   if(!dependencies.some(d=>d.path==="package-lock.json")||!dependencies.some(d=>d.path==="package.json"))throw new Error("environment_lockfile_required");
   try{await lstat(path.join(workspace.checkout,".npmrc"));throw new Error("environment_project_npm_config");}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
   const result=await agent.peer.command("bash",{command:[agent.backend==="docker"?"/usr/local/bin/node":process.execPath,agent.backend==="docker"?"/usr/local/lib/node_modules/npm/bin/npm-cli.js":npm!,"ci","--ignore-scripts","--no-audit","--no-fund",`--userconfig=${agent.backend==="docker"?"/home/agent/.npmrc":path.join(workspace.home,".npmrc")}`,`--globalconfig=${agent.backend==="docker"?"/home/agent/npm-global.conf":path.join(workspace.home,"npm-global.conf")}`,agent.backend==="docker"?"--registry=http://127.0.0.1:39871/registry/":"--registry=https://registry.npmjs.org"].map(quote).join(" ")},120000);
   if((result.data as {exitCode?:number})?.exitCode!==0)throw new Error("environment_install_failed");
  }else if(recipe.install!=="none")throw new Error("environment_recipe_unsupported");
  await store.environmentSetup(executor,claim.run.id,claim.run.epoch,{status:"ready",runtime,dependencies,install:recipe.install,services:{postgres:"fresh isolated schema",port:workspace.port??null},omissions:["Test database contents and running services are not copied.","Only npm-ci is automated; other dependency managers require an explicit project step.","Install lifecycle scripts are disabled; no production secrets are injected."]});
 }catch(e){const code=e instanceof Error&&e.message.startsWith("environment_")?e.message:"environment_setup_failed";await store.environmentSetup(executor,claim.run.id,claim.run.epoch,{status:"failed",runtime,dependencies,install:recipe.install,error:code});throw new Error(code);}
}
