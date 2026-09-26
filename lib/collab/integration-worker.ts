import { watchArtifact } from "./runtime/artifact-storage";
import type { ExecutionStore } from "./execution-store";
import type { IntegrationClaim, IntegrationEvidence } from "./integration-schema";
import { integrate } from "./runtime/integration";
export async function executeIntegration(store:ExecutionStore,claim:IntegrationClaim,root:string,external?:AbortSignal,heartbeatMs=5000){
 const controller=new AbortController();let pending:Promise<void>|undefined,controlLost=false,checkingStarted=false;
 const cancel=()=>controller.abort();external?.addEventListener("abort",cancel,{once:true});if(external?.aborted)cancel();
 const heartbeat=()=>pending??=(async()=>{try{if(!await store.heartbeatIntegration(claim))cancel();}catch{controlLost=true;cancel();}})().finally(()=>{pending=undefined;});
 let evidence:IntegrationEvidence|null=null,outcome:IntegrationEvidence["outcome"]="unknown",failure:string|null=null;
 let storage:Awaited<ReturnType<typeof watchArtifact>>|undefined;
 const timer=setInterval(()=>void heartbeat(),heartbeatMs);
 try{
  storage=await watchArtifact(store,root,"integration",claim.id,cancel);
  await heartbeat();if(controller.signal.aborted)outcome="cancelled";
  else{evidence=await integrate(root,claim,controller.signal,async()=>{if(!await store.heartbeatIntegration(claim,true)){cancel();throw new Error("integration_cancelled");}checkingStarted=true;});outcome=evidence.outcome;}
 }catch(error){
  const message=error instanceof Error?error.message:"";
  // Before checks begin, Git operations only modify a private candidate. An
  // unexpected failure after executing project code is conservatively unknown.
  outcome=checkingStarted?"unknown":controller.signal.aborted?"cancelled":"check_failed";
  failure=/^(integration_|snapshot_)[a-z_]+$/.test(message)?message:"integration_outcome_unknown";
 }finally{const storageFailure=await storage?.finish();if(storageFailure){failure=storageFailure;if(outcome!=="unknown"){outcome="cancelled";if(evidence)evidence.outcome="cancelled";}}clearInterval(timer);external?.removeEventListener("abort",cancel);if(pending)await pending;}
 if(controlLost){outcome="unknown";failure="integration_control_lost";evidence=null;}
 return store.finishIntegration(claim,outcome,evidence,failure);
}
