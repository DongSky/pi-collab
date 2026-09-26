import {createHash} from 'node:crypto';
import {mkdir,open} from 'node:fs/promises';
import path from 'node:path';
import {z} from 'zod';
import {DockerRuntimeBackend,type AgentProcess} from './backends';
import {loadSnapshot,restoreSnapshot,materializeDependencyInputs,verifyDependencyInputs,verifySnapshotWorkingTree} from './snapshots';
import {materializeContractInputs,verifyContractInputs} from './contract-inputs';
import {materializeResolutionInputs,verifyResolutionInputs} from './resolution-inputs';
import {resolutionInputSchema} from '../resolution-schema';
import {assertResolutionMarkersAbsent} from './resolution-markers';
import {validationConfig} from '../validation-config';
import type {ValidationClaim,ValidationEvidence,StepEvidence} from './validation';
const hash=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
const quote=(value:string)=>"'"+value.replaceAll("'","'\\''")+"'";
async function durable(file:string,value:unknown){const f=await open(file,'wx',0o600);try{await f.writeFile(JSON.stringify(value));await f.sync();}finally{await f.close();}}
/** Commands execute in a network-isolated container. Only fixed snapshot copies are writable.
 * Each request owns one exclusive execution directory and container receipt; ambiguous execution is never replayed. */
export async function validateContainerSnapshot(root:string,claim:ValidationClaim,signal:AbortSignal):Promise<ValidationEvidence>{
 z.uuid().parse(claim.id);z.uuid().parse(claim.executorId);z.uuid().parse(claim.profileId);const config=validationConfig.parse(claim.config),configHash=hash(JSON.stringify(config)),dir=path.join(root,'validation-executions',claim.id);
 await mkdir(path.dirname(dir),{recursive:true,mode:0o700});await mkdir(dir,{mode:0o700});await durable(path.join(dir,'admitted.json'),{id:claim.id,executorId:claim.executorId,epoch:claim.epoch,snapshotId:claim.snapshotId,manifestHash:claim.manifestHash,configHash,runtime:'docker'});
 const {manifest,blobs}=await loadSnapshot(root,claim.snapshotId,claim.manifestHash);if(manifest.repositoryId!==claim.repositoryId)throw new Error('validation_source_mismatch');
 const resolution=claim.resolution?resolutionInputSchema.parse(claim.resolution):null;if(JSON.stringify(manifest.resolution)!==JSON.stringify(resolution)||(resolution&&resolution.profileId!==claim.profileId))throw new Error('snapshot_resolution_input_invalid');if(resolution||claim.revert)assertResolutionMarkersAbsent(manifest.worktree.map(e=>blobs.get(e.hash)!));
 const workspace=await restoreSnapshot(root,claim.id,claim.snapshotId,claim.manifestHash);await materializeDependencyInputs(root,workspace.root,manifest.dependencies);await materializeContractInputs(workspace.root,manifest.contracts);await materializeResolutionInputs(workspace.root,resolution);
 let agent:AgentProcess|undefined,cleanup=false,interrupted=false;
 const cancel=()=>{interrupted=true;void agent?.stop().catch(()=>{});};signal.addEventListener('abort',cancel,{once:true});
 const evidence:ValidationEvidence={version:1,validationId:claim.id,snapshotId:claim.snapshotId,manifestHash:claim.manifestHash,worktreeCommit:manifest.worktreeCommit,profileId:claim.profileId,configHash,config,dependencies:manifest.dependencies,contracts:manifest.contracts,...(resolution?{resolution,resolutionMarkersAbsent:true}:{}),...(claim.revert?{revertMarkersAbsent:true}:{}),environment:{policy:'container-fixed-validation-v1',node:'unavailable',nodeHash:'',npmCliHash:null,platform:'linux',arch:'unavailable',kernel:'unavailable'},excludedCount:manifest.excluded.length,steps:[],outcome:'failed'};
 try{
  if(signal.aborted){evidence.outcome='cancelled';return evidence;}
  agent=await new DockerRuntimeBackend().start(workspace,undefined,{runId:claim.id,executorId:claim.executorId,epoch:claim.epoch});
  const runtime=agent.runtimeEvidence!;evidence.environment={policy:'container-fixed-validation-v1',node:runtime.node,nodeHash:runtime.nodeHash,npmCliHash:runtime.npmHash,platform:runtime.platform,arch:runtime.arch,kernel:runtime.kernel,image:runtime.image};evidence.outcome='passed';
  for(const step of config.steps){
   if(signal.aborted){evidence.outcome='cancelled';break;}
   const startedAt=new Date().toISOString();let error:string|null=null,exitCode:number|null=null,output='';
   const result:StepEvidence={...step,exitCode:null,signal:null,startedAt,finishedAt:startedAt,outputBytes:0,outputHash:hash(''),hashedBytes:0,outputTruncated:false,error:null,cleanupConfirmed:false,sourceUnchanged:false};
   const timeout=setTimeout(()=>{error='validation_timeout';cancel();},step.timeoutSeconds*1000);
   try{const response=await agent.peer.command('bash',{command:[...(step.tool==='npm'?['/usr/bin/env','npm_config_registry=http://127.0.0.1:39871/registry/','npm_config_audit=false','npm_config_fund=false']:[]),'/usr/local/bin/node',...(step.tool==='npm'?['/usr/local/lib/node_modules/npm/bin/npm-cli.js']:[]),...step.args].map(quote).join(' ')},step.timeoutSeconds*1000+15000),data=response.data as {exitCode?:number;output?:string;truncated?:boolean};exitCode=data.exitCode??null;output=data.output??'';if(exitCode!==0)error??='validation_nonzero_exit';if(data.truncated)error??='validation_output_limit';}
   catch{error??=signal.aborted?'validation_cancelled':'validation_execution_unconfirmed';}
   finally{clearTimeout(timeout);}
   const bytes=Buffer.from(output),kept=bytes.subarray(0,1024*1024);if(bytes.length>kept.length)error??='validation_output_limit';Object.assign(result,{exitCode,error,finishedAt:new Date().toISOString(),outputBytes:bytes.length,outputHash:hash(kept),hashedBytes:kept.length,outputTruncated:kept.length<bytes.length});
   if(!error){try{await verifySnapshotWorkingTree(workspace.checkout,manifest);await verifyDependencyInputs(root,workspace.root,manifest.dependencies);await verifyContractInputs(workspace.root,manifest.contracts);await verifyResolutionInputs(workspace.root,resolution);result.sourceUnchanged=true;}catch{error='validation_source_changed';result.error=error;}}
   evidence.steps.push(result);if(error){evidence.outcome=signal.aborted?'cancelled':'failed';break;}
  }
 }catch{evidence.outcome='unknown';}
 finally{
  signal.removeEventListener('abort',cancel);
  if(agent){try{await agent.stop();cleanup=true;}catch{evidence.outcome='unknown';}}
 }
 if(cleanup){
  let unchanged=false;try{await verifySnapshotWorkingTree(workspace.checkout,manifest);await verifyDependencyInputs(root,workspace.root,manifest.dependencies);await verifyContractInputs(workspace.root,manifest.contracts);await verifyResolutionInputs(workspace.root,resolution);unchanged=true;}catch{if(evidence.outcome==='passed')evidence.outcome='failed';}
  for(const step of evidence.steps){step.cleanupConfirmed=true;step.sourceUnchanged=unchanged;if(!unchanged)step.error??='validation_source_changed';}
 }else if(agent)evidence.outcome='unknown';
 if(signal.aborted&&evidence.outcome!=='unknown')evidence.outcome='cancelled';
 if(interrupted&&evidence.outcome==='passed')evidence.outcome='failed';
 await durable(path.join(dir,'evidence.json'),evidence);return evidence;
}
