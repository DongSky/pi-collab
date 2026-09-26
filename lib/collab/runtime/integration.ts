import { mkdir, open } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { createWorkspace } from "./workspace";
import { captureSnapshot } from "./snapshots";
import { materializeContractInputs } from "./contract-inputs";
import { validateSnapshot } from "./validation";
import { integrationSourcesSchema, type IntegrationClaim, type IntegrationEvidence } from "../integration-schema";
import { checkedCompositionGit, composeIntegrationSources, legacyConflict } from "./integration-composition";

const sha=z.string().regex(/^[a-f0-9]{40}$/);
async function durable(file:string,value:unknown){const h=await open(file,"wx",0o600);try{await h.writeFile(JSON.stringify(value));await h.sync();}finally{await h.close();}const dir=await open(path.dirname(file),"r");try{await dir.sync();}finally{await dir.close();}}

/** Local preview only: every Git write targets a fresh private checkout.
 * The imported repository and all source task workspaces stay unchanged. */
export async function integrate(root:string,claim:IntegrationClaim,signal:AbortSignal,checking:()=>Promise<void>):Promise<IntegrationEvidence>{
 z.uuid().parse(claim.id);z.uuid().parse(claim.checkId);z.uuid().parse(claim.repositoryId);sha.parse(claim.targetSha);
 integrationSourcesSchema.parse(claim.sources);
 const directory=path.join(root,"integrations",claim.id);await mkdir(path.dirname(directory),{recursive:true,mode:0o700});await mkdir(directory,{mode:0o700});
 const workspace=await createWorkspace(root,claim.id,path.join(root,"repositories",claim.repositoryId,"git"),claim.targetSha,true);
 const evidence:IntegrationEvidence={version:1,integrationId:claim.id,repositoryId:claim.repositoryId,targetBranch:claim.targetBranch,targetSha:claim.targetSha,inputHash:claim.inputHash,sources:claim.sources,merges:[],conflict:null,candidateCommit:null,snapshot:null,validation:null,outcome:"unknown"};
 const combined=await composeIntegrationSources(root,workspace.checkout,claim,signal);
 evidence.merges=combined.merges;
 if(combined.conflicts.length){evidence.conflict=legacyConflict(combined.conflicts[0]);evidence.outcome="conflicted";await durable(path.join(directory,"evidence.json"),evidence);return evidence;}
 const current=combined.current,contracts=combined.contracts;
 // Reset only this integration's private branch. No other checkout/ref is used.
 await checkedCompositionGit(workspace.checkout,["reset","--hard",current],signal);evidence.candidateCommit=current;
 await materializeContractInputs(workspace.root,contracts);
 const saved=await captureSnapshot(root,{id:claim.id,runId:claim.id,workspaceId:claim.id,repositoryId:claim.repositoryId,baseSha:claim.targetSha,note:"Immutable local integration preview",contracts:contracts,context:{title:"Integration preview",description:"Combined published results",acceptance:"Execute configured checks on the exact combined snapshot",prompt:"",status:"checking"}});
 evidence.snapshot={id:claim.id,manifestHash:saved.manifestHash,worktreeCommit:saved.manifest.worktreeCommit,excluded:saved.manifest.excluded};
 await durable(path.join(directory,"candidate.json"),{...evidence,outcome:"unknown"});
 await checking();
 evidence.validation=await validateSnapshot(root,{runtime:claim.runtime,id:claim.checkId,executorId:claim.executorId,epoch:claim.epoch,snapshotId:claim.id,manifestHash:saved.manifestHash,repositoryId:claim.repositoryId,profileId:claim.profileId,config:claim.config},signal);
 evidence.outcome=evidence.validation.outcome==="passed"?"checked":evidence.validation.outcome==="failed"?"check_failed":evidence.validation.outcome;
 await durable(path.join(directory,"evidence.json"),evidence);return evidence;
}
