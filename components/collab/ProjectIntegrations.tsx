"use client";
import {useEffect,useRef,useState,type FormEvent} from "react";
import {collabApi,CollabApiError} from "./api";
import {IntegrationPolicyEditor,IntegrationReviews,type IntegrationPolicy,type IntegrationReviewState} from "./IntegrationReviews";
import {ResolutionCreator,type ResolutionMember} from "./ResolutionTasks";
import {IntegrationPromotions,type PromotionSummary} from "./IntegrationPromotions";
import {ManagedReverts} from "./ManagedReverts";
import {IntegrationCode} from "./IntegrationCode";
type Repository={id:string;name:string;base_sha:string;default_branch?:string};
type Source={resultId:string;taskId:string;worktreeCommit:string};
type Integration={id:string;runtime:"native"|"docker";promotions:PromotionSummary[];excluded:{path:string;reason:string}[];policy_id:string|null;resolution_task:{id:string;title:string}|null;review_state:IntegrationReviewState;repository_id:string;target_branch:string;target_sha:string;status:string;input_state:string;stop_requested:boolean;can_cancel:boolean;error_code:string|null;candidate_commit:string|null;sources:Source[];source_titles:Record<string,string>;conflict:{resultId:string;files:{path:string;base:string|null;ours:string|null;theirs:string|null}[]}|null};
type Listing={integrations:Integration[];results:{id:string;task_id:string;title:string;version:number;repository_id:string;worktree_commit:string;input_state:string}[]};
const names:Record<string,string>={queued:"等待整合",integrating:"组合代码中",checking:"运行组合检查",checked:"组合检查通过",conflicted:"代码合并冲突",check_failed:"组合检查未通过",stale:"输入已过期",cancelled:"已取消整合",revoked:"整合权限已变化",unknown:"整合结果未知"};
export function ProjectIntegrations({projectId,role,repositories,eventGeneration,userId,members,onOpenTask}:{projectId:string;role:string;repositories:Repository[];eventGeneration:number;userId:string;members:ResolutionMember[];onOpenTask:(taskId:string)=>Promise<void>}){
 const [data,setData]=useState<Listing|null>(null),[profiles,setProfiles]=useState<{id:string;name:string;repository_id:string}[]>([]);
 const [policies,setPolicies]=useState<IntegrationPolicy[]>([]);
 const [repositoryId,setRepositoryId]=useState(""),[profileId,setProfileId]=useState(""),[selected,setSelected]=useState<string[]>([]),[reason,setReason]=useState("");
 const [busy,setBusy]=useState(false),[retry,setRetry]=useState(false),[error,setError]=useState(""),[refresh,setRefresh]=useState(0);
 const pending=useRef<{endpoint:string;body:unknown}|null>(null),canCreate=["maintainer","developer"].includes(role);
 const repository=repositories.find(r=>r.id===repositoryId),policy=policies.find(p=>p.repository_id===repositoryId),effectiveProfileId=policy?.profile_id??profileId;
 const currentResultIds=new Set(data?.results.filter(r=>r.repository_id===repositoryId&&r.input_state==="current").map(r=>r.id));
 const hasStaleSelection=selected.some(id=>!currentResultIds.has(id));
 useEffect(()=>{
  let active=true,loading=false;
  async function load(){if(loading)return;loading=true;try{const [listing,p,rules]=await Promise.all([collabApi<Listing>(`projects/${projectId}/integrations`),collabApi<{profiles:typeof profiles}>(`projects/${projectId}/validation-profiles`),collabApi<{policies:IntegrationPolicy[]}>(`projects/${projectId}/integration-policies`)]);if(active){setData(listing);setProfiles(p.profiles);setPolicies(rules.policies);}}catch(e){if(active){setError(e instanceof Error?e.message:"读取整合队列失败");if(e instanceof CollabApiError&&[401,403,404].includes(e.status)){setData(null);setProfiles([]);setPolicies([]);}}}finally{loading=false;}}
  void load();const timer=setInterval(()=>{if(document.visibilityState==="visible")void load();},5000),resume=()=>{if(document.visibilityState==="visible")void load();};document.addEventListener("visibilitychange",resume);window.addEventListener("online",resume);
  return()=>{active=false;clearInterval(timer);document.removeEventListener("visibilitychange",resume);window.removeEventListener("online",resume);};
 // Profiles are immutable; keeping the request lifetime separate protects form choices.
 },[projectId,eventGeneration,refresh]);
 async function submit(endpoint:string,body:unknown){if(busy)return false;setBusy(true);setError("");pending.current??={endpoint,body};try{await collabApi(pending.current.endpoint,pending.current.body);pending.current=null;setRetry(false);setRefresh(n=>n+1);return true;}catch(e){if(e instanceof CollabApiError&&e.status<500){pending.current=null;setRefresh(n=>n+1);}setRetry(!!pending.current);setError(e instanceof Error?e.message:"整合操作失败");return false;}finally{setBusy(false);}}
 function create(event:FormEvent){event.preventDefault();if(!repository||hasStaleSelection)return;void submit(`projects/${projectId}/integrations`,{repositoryId,targetSha:repository.base_sha,resultIds:selected,profileId:effectiveProfileId,expectedPolicyId:policy?.id??null,idempotencyKey:crypto.randomUUID()});}
 return <section className="collab-snapshots" aria-label="项目 Git 整合队列">
  <div className="collab-section-heading"><div><p className="collab-eyebrow">独立组合 · 按版本验证</p><h2>项目 Git 整合队列</h2></div></div>
  <p className="collab-muted collab-small">选择已发布成果，平台自动纳入同仓库依赖并按顺序组合，在新的工作区执行检查。同一目标分支串行处理，成员的代码工作区保留。检查和独立评审通过后，维护者可推进平台管理的本地 Git 基线。</p>
  {error&&<p className="collab-error" role="alert">{error}</p>}
  {retry&&<button className="collab-button" disabled={busy} onClick={()=>pending.current&&void submit(pending.current.endpoint,pending.current.body)}>重试同一整合操作</button>}
  {role==="maintainer"&&<IntegrationPolicyEditor projectId={projectId} repositories={repositories} profiles={profiles} policies={policies} disabled={busy||retry} submit={submit}/>}
  {canCreate&&<form className="collab-form compact" onSubmit={create}>
   <label>整合仓库<select aria-label="整合仓库" required value={repositoryId} disabled={busy||retry} onChange={e=>{setRepositoryId(e.target.value);setProfileId("");setSelected([]);}}><option value="">选择仓库</option>{repositories.map(r=><option key={r.id} value={r.id}>{r.name} · {r.default_branch??"导入基线"}</option>)}</select></label>
   {repository&&<p className="collab-muted collab-small">目标基线 {repository.base_sha.slice(0,12)}</p>}
   <label>组合验证配置<select aria-label="组合验证配置" required value={effectiveProfileId} disabled={busy||retry||!!policy} onChange={e=>setProfileId(e.target.value)}><option value="">选择维护者创建的验证配置</option>{profiles.filter(p=>p.repository_id===repositoryId).map(p=><option key={p.id} value={p.id}>{p.name} · {p.id.slice(0,8)}</option>)}</select></label>
   {policy&&<div className="collab-muted collab-small"><p>必跑规则 v{policy.version} · {policy.profile_name} · 需要 {policy.required_approvals} 位独立批准</p><ol>{policy.config.steps.map((step,index)=><li key={index} className="collab-prewrap">{step.tool} {step.args.map(arg=>JSON.stringify(arg)).join(" ")} · {step.timeoutSeconds} 秒</li>)}</ol></div>}
   <fieldset disabled={busy||retry}><legend>待组合的成果</legend>{data?.results.filter(r=>r.repository_id===repositoryId).map(r=><label key={r.id}><input type="checkbox" checked={selected.includes(r.id)} disabled={r.input_state!=="current"&&!selected.includes(r.id)} onChange={e=>setSelected(ids=>e.target.checked?[...ids,r.id]:ids.filter(id=>id!==r.id))}/>{r.title} · v{r.version} · {r.worktree_commit.slice(0,10)}{r.input_state!=="current"&&" · 输入过期"}</label>)}</fieldset>
   {hasStaleSelection&&<p role="status" className="collab-error">所选成果已失效或被新版本替代，请移除后重新核对组合。<button type="button" className="collab-text-button" disabled={busy||retry} onClick={()=>setSelected(ids=>ids.filter(id=>currentResultIds.has(id)))}>移除失效选择</button></p>}
   <button className="collab-button" disabled={busy||retry||hasStaleSelection||!selected.length||!effectiveProfileId}>创建整合预演</button>
  </form>}
  <ManagedReverts key={projectId} projectId={projectId} role={role} onOpen={onOpenTask}/>
  {!data?.integrations.length&&<p className="collab-muted">暂无整合预演。</p>}
  {data?.integrations.map(item=><article key={item.id} className="collab-snapshot-card" aria-label={`整合 ${item.id}`}>
   <strong role="status">{item.status==="checked"&&item.input_state!=="current"?"历史检查通过 · 已失效":names[item.status]}</strong><p className="collab-muted collab-small">{repositories.find(r=>r.id===item.repository_id)?.name} · {item.target_branch} · {item.runtime === "docker" ? "容器验证" : "原生验证"} · 基线 {item.target_sha.slice(0,12)}</p>
   {item.input_state!=="current"&&<p className="collab-error" role="status">{item.input_state==="stale"?"成果、依赖或目标基线已变化，或整合规则已更新；旧检查不能用于新组合。":"申请人的权限已变化；旧结果不再有效。"}</p>}
   <ol className="collab-small">{item.sources.map(s=><li key={s.resultId}>{item.source_titles[s.taskId]??s.taskId.slice(0,8)} · 成果 {s.resultId.slice(0,8)} · {s.worktreeCommit.slice(0,12)}</li>)}</ol>
   {item.candidate_commit&&<p className="collab-muted collab-small">Git 候选 {item.candidate_commit.slice(0,12)}</p>}
   {item.conflict&&<div><p>冲突来源成果 {item.conflict.resultId.slice(0,8)}</p>{item.conflict.files.map(file=><p className="collab-prewrap collab-small" key={file.path}>{file.path} · base {file.base?.slice(0,8)??"无"} · ours {file.ours?.slice(0,8)??"无"} · theirs {file.theirs?.slice(0,8)??"无"}</p>)}</div>}
   {item.conflict&&<ResolutionCreator integrationId={item.id} userId={userId} role={role} members={members} existing={item.resolution_task} enabled={item.status==="conflicted"&&item.input_state==="current"&&!!item.policy_id} onOpen={onOpenTask}/>}
   {item.status==="unknown"&&<p className="collab-muted">旧执行结果尚待核查，此目标分支继续阻塞，不会自动重跑项目命令。</p>}
   {item.stop_requested&&["integrating","checking"].includes(item.status)&&<p className="collab-muted">已请求取消，正在等待进程退出。</p>}
   {(item.candidate_commit||item.conflict)&&<IntegrationCode id={item.id} inputState={item.input_state}/>}
   <IntegrationReviews id={item.id} state={item.review_state} disabled={busy||retry} submit={submit}/>
   <IntegrationPromotions id={item.id} role={role} target={item.target_sha} candidate={item.candidate_commit} branch={item.target_branch} revision={item.review_state.revisionHash} ready={item.review_state.reviewSatisfied} promotions={item.promotions} excluded={item.excluded} disabled={busy||retry} submit={submit}/>
   {item.error_code&&<p className="collab-muted collab-small">诊断代码：{item.error_code}</p>}
   <a className="collab-text-button" href={`/api/collab/integrations/${item.id}`} download>查看整合与评审证据</a>
   {canCreate&&item.can_cancel&&["queued","integrating","checking"].includes(item.status)&&<details><summary>取消整合</summary><form className="collab-form compact" onSubmit={e=>{e.preventDefault();void submit(`integrations/${item.id}`,{reason,idempotencyKey:crypto.randomUUID()});}}><label>取消原因<textarea aria-label="整合取消原因" required minLength={10} maxLength={2000} disabled={busy||retry} value={reason} onChange={e=>setReason(e.target.value)}/></label><button className="collab-button" disabled={busy||retry||item.stop_requested}>确认取消整合</button></form></details>}
  </article>)}
  <p className="collab-muted collab-small">最多展示 50 项整合、每项最近 10 次推进和 100 项当前成果。验证执行的是快照中保留的代码；秘密路径、生成目录等排除项会记录在证据中。候选与检查均固定版本；本地推进不会发布到远程仓库。</p>
 </section>;
}
