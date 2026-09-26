"use client";
import { useCallback, useEffect, useState } from "react";
import { ArtifactStorage } from "./ArtifactStorage";
import { RuntimeLimits } from "./RuntimeLimits";
import { Scheduling } from "./Scheduling";
import { WorkspaceEnvironments } from "./WorkspaceEnvironments";
import { collabApi } from "./api";
type Price={inputUsdPerMillion:string;outputUsdPerMillion:string;source:string};
type Context={version:number;projectRuns:number;memberRuns:number;dailyTokens:string;dailyUsd:string|null;canManage:boolean;day:string;models:{id:string;name:string;model_id:string;price:Price|null}[];usage:{settledUsd:string;reservedUsd:string;uncertainUsd:string;unpricedRequests:number;requests:number;tokens:string};members:{user_id:string;name:string;active:number;queued:number}[];recent:{id:string;run_id:string;title:string;status:string;created_at:string;charged_tokens:number;charged_usd:string|null;price_id:string|null}[]};
export function Capacity({projectId}:{projectId:string}) {
 const [data,setData]=useState<Context|null>(null),[error,setError]=useState(""),[notice,setNotice]=useState(""),[busy,setBusy]=useState(false),[editing,setEditing]=useState(false);
 const route=`projects/${projectId}/capacity`;
 const load=useCallback(async()=>{try{setData(await collabApi<Context>(route));setError("");}catch(e){setError(e instanceof Error?e.message:"读取用量失败");}},[route]);
 useEffect(()=>{void load();const timer=setInterval(()=>{if(!document.hidden&&!editing)void load();},5000);return()=>clearInterval(timer);},[load,editing]);
 async function save(event:React.FormEvent<HTMLFormElement>){event.preventDefault();if(!data)return;const f=new FormData(event.currentTarget);setBusy(true);setError("");try{
  const prices=data.models.filter(m=>f.get(`price-${m.id}`)==="on").map(m=>({profileId:m.id,inputUsdPerMillion:String(f.get(`in-${m.id}`)),outputUsdPerMillion:String(f.get(`out-${m.id}`)),source:String(f.get(`source-${m.id}`))}));
  await collabApi(route,{expectedVersion:data.version,idempotencyKey:crypto.randomUUID(),reason:f.get("reason"),projectRuns:Number(f.get("projectRuns")),memberRuns:Number(f.get("memberRuns")),dailyTokens:Number(f.get("dailyTokens")),dailyUsd:f.get("dailyUsd")||null,prices},"PUT");setEditing(false);setNotice("并发与预算已保存，之后的新运行和模型请求使用新设置。");await load();
 }catch(e){setError(e instanceof Error?e.message:"保存失败，请刷新核对设置");}finally{setBusy(false);}}
 const usd=(v:string|null)=>v===null?"价格未知":`$${Number(v).toFixed(8)}`;
 return <section aria-label="资源与费用" className="collab-panel"><h2>资源与费用</h2><p className="collab-muted">并发按本项目计算。费用为 USD 估算，按 UTC 日期统计；缓存优惠暂按普通输入价估算，以提供商账单为准。</p>
  {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
  <button className="collab-text-button" disabled={busy} onClick={()=>void load()}>刷新用量</button>
  {data&&<><h3>{data.day} · 今日用量</h3><div className="collab-map-stats"><div><strong>{usd(data.usage.settledUsd)}</strong><span>已知用量估算</span></div><div><strong>{usd(data.usage.reservedUsd)}</strong><span>请求预留</span></div><div><strong>{usd(data.usage.uncertainUsd)}</strong><span>结果未知，保留额度</span></div><div><strong>{data.usage.unpricedRequests}</strong><span>价格未知的请求</span></div></div>
  <p>{data.usage.requests} 次请求 · {data.usage.tokens} / {data.dailyTokens} tokens（含预留） · 每日金额上限 {data.dailyUsd===null?"未启用":usd(data.dailyUsd)}</p>
  <p>项目并发 {data.members.reduce((n,m)=>n+m.active,0)} / {data.projectRuns}，每人上限 {data.memberRuns}。调低限额不强停活动 AI，空出名额后才会启动排队任务。</p>
  {data.members.map(m=><p key={m.user_id}>{m.name}：{m.active} 个活动 · {m.queued} 个排队{m.queued>0&&(m.active>=data.memberRuns||data.members.reduce((n,x)=>n+x.active,0)>=data.projectRuns)?" · 等待并发名额":m.queued>0?" · 等待依赖或执行器":""}</p>)}
  <h3>模型价格</h3>{data.models.map(m=><p key={m.id}>{m.name}：{m.price?`输入 $${m.price.inputUsdPerMillion} / 输出 $${m.price.outputUsdPerMillion} 每百万 tokens · ${m.price.source}`:"未配置，费用未知"}</p>)}
  {data.canManage&&<><button className="collab-button" onClick={()=>setEditing(!editing)} disabled={busy}>{editing?"取消编辑":"配置并发与预算"}</button>{editing&&<form className="collab-form" onSubmit={save} key={data.version}>
   <label>项目同时运行 AI 数<input name="projectRuns" type="number" min={1} max={32} defaultValue={data.projectRuns} required/></label>
   <label>每位成员同时运行 AI 数<input name="memberRuns" type="number" min={1} max={16} defaultValue={data.memberRuns} required/></label>
   <label>每日 token 上限<input name="dailyTokens" type="number" min={1024} max={1000000000} defaultValue={data.dailyTokens} required/></label>
   <label>每日费用上限（USD，留空不启用）<input name="dailyUsd" type="number" min="0.00000001" step="0.00000001" max={1000000} defaultValue={data.dailyUsd??""}/></label>
   <p className="collab-small">启用金额预算后，模型价格未知或当天存在无法定价的历史请求会阻止新模型调用。响应未知时保留整个预留金额，不能通过刷新退款。</p>
   {data.models.map(m=><fieldset key={m.id}><legend>{m.name}</legend><label><input type="checkbox" name={`price-${m.id}`}/>发布此模型的新价格</label><label>输入 USD / 百万 tokens<input name={`in-${m.id}`} type="number" min={0} step="0.00000001" max={100000} defaultValue={m.price?.inputUsdPerMillion??""}/></label><label>输出 USD / 百万 tokens<input name={`out-${m.id}`} type="number" min={0} step="0.00000001" max={100000} defaultValue={m.price?.outputUsdPerMillion??""}/></label><label>价格来源<input name={`source-${m.id}`} maxLength={500} defaultValue={m.price?.source??""}/></label></fieldset>)}
   <label>修改说明<textarea name="reason" minLength={10} maxLength={2000} required/></label><p className="collab-small">维护者须启用 MFA，修改留有审计记录。旧请求保留原价格。</p><button className="collab-button" disabled={busy}>保存并发与预算</button>
  </form>}</>}
  <h3>最近模型请求</h3>{data.recent.length?data.recent.map(q=><article className="collab-result-card" key={q.id}><strong>{q.title}</strong><p>{({completed:"已结算",reserved:"预留中",unknown:"结果未知，保留额度"} as Record<string,string>)[q.status]} · {usd(q.charged_usd)} · {q.charged_tokens} tokens</p><time>{new Date(q.created_at).toLocaleString()}</time></article>):<p>暂无模型请求。</p>}
  </>}
 <Scheduling projectId={projectId}/>
 <RuntimeLimits projectId={projectId}/>
 <ArtifactStorage projectId={projectId}/>
 <WorkspaceEnvironments projectId={projectId}/>
 </section>;
}
