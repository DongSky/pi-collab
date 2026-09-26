"use client";
import {useCallback,useEffect,useRef,useState,type FormEvent} from 'react';
import {ServicePreviews} from "./ServicePreviews";
import {collabApi,CollabApiError} from './api';
type Preview={id:string;title:string;status:string;author_id:string;validation_id:string;snapshot_id:string;snapshot_hash:string;artifact_hash:string|null;expires_at:string;failure:string|null;file_count:number|null;total_bytes:number|null;cleaned_at:string|null};
type Listing={role:string;configured:boolean;previews:Preview[];logs:{id:string;preview_id:string;path:string;status:number;created_at:string}[]};
const names:Record<string,string>={preparing:'准备中',ready:'可预览',failed:'创建失败',revoked:'已撤销',expired:'已到期'};
export function CheckpointPreviews({taskId,userId}:{taskId:string;userId:string}){
 const[data,setData]=useState<Listing|null>(null),[validations,setValidations]=useState<{id:string;status:string;profile_name:string}[]>([]),[selected,setSelected]=useState(''),[title,setTitle]=useState('检查点页面预览'),[folder,setFolder]=useState('preview'),[entry,setEntry]=useState('index.html'),[busy,setBusy]=useState(false),[error,setError]=useState(''),[reason,setReason]=useState(''),[opened,setOpened]=useState<{id:string;url:string;expiresAt:string}|null>(null);
 const access=useRef({active:true,epoch:0,read:0});
 const failed=useCallback((error:unknown)=>{
  if(error instanceof CollabApiError&&[401,403,404].includes(error.status)){access.current.epoch++;access.current.read++;setData(null);setValidations([]);setOpened(null);setSelected('');}
  setError(error instanceof Error?error.message:'预览操作失败');
 },[]);
 const refresh=useCallback(async()=>{
  const read=++access.current.read,epoch=access.current.epoch,current=()=>access.current.active&&access.current.read===read&&access.current.epoch===epoch;
  try{const [next,v]=await Promise.all([collabApi<Listing>(`tasks/${taskId}/previews`),collabApi<{validations:typeof validations}>(`tasks/${taskId}/validations`)]);
   if(!current())return;setData(next);setValidations(v.validations.filter(x=>x.status==='passed'));setError('');setOpened(old=>old&&next.previews.some(p=>p.id===old.id&&p.status==='ready')&&new Date(old.expiresAt).getTime()>Date.now()?old:null);
  }catch(e){if(current())failed(e);}
 },[taskId,failed]);
 useEffect(()=>{const lifecycle=access.current;lifecycle.active=true;void refresh();const resume=()=>{if(document.visibilityState==='visible')void refresh();};const timer=setInterval(resume,5000);document.addEventListener('visibilitychange',resume);window.addEventListener('online',resume);return()=>{lifecycle.active=false;lifecycle.epoch++;lifecycle.read++;clearInterval(timer);document.removeEventListener('visibilitychange',resume);window.removeEventListener('online',resume);};},[refresh]);
 useEffect(()=>{if(!opened)return;const timer=setTimeout(()=>setOpened(null),Math.max(0,new Date(opened.expiresAt).getTime()-Date.now()));return()=>clearTimeout(timer);},[opened]);
 async function create(e:FormEvent){e.preventDefault();const epoch=access.current.epoch,current=()=>access.current.active&&access.current.epoch===epoch;setBusy(true);setError('');try{await collabApi(`tasks/${taskId}/previews`,{validationId:selected,title,folder,entry});if(current())await refresh();}catch(e){if(current())failed(e);}finally{if(access.current.active)setBusy(false);}}
 async function action(p:Preview,action:string){const epoch=access.current.epoch,current=()=>access.current.active&&access.current.epoch===epoch;setBusy(true);setError('');try{const result=await collabApi<{url:string;expiresAt:string}>(`previews/${p.id}`,action==='open'?{action}:{action,reason});if(!current())return;if(action==='open')setOpened({id:p.id,...result});else setOpened(old=>old?.id===p.id?null:old);await refresh();}catch(e){if(current())failed(e);}finally{if(access.current.active)setBusy(false);}}
 return <section className="collab-snapshots" aria-label="检查点独立预览"><h2>检查点独立预览</h2><p className="collab-muted collab-small">从通过验证的固定快照复制静态 HTML、CSS、JS 与图片，在独立来源的浏览器沙箱中展示。不会写回 AI 工作区，也不启动项目服务端。预览保留 1 小时，个人访问每 5 分钟更新一次。</p>{error&&<p role="alert" className="collab-error">{error}</p>}
 {data&&!data.configured&&<p>部署管理员尚未配置独立预览来源。</p>}
 {data&&['maintainer','developer','reviewer'].includes(data.role)&&<details><summary>从验证检查点创建预览</summary><form className="collab-form compact" onSubmit={create}><label>预览验证来源<select aria-label="预览验证来源" required value={selected} onChange={e=>setSelected(e.target.value)}><option value="">选择通过的验证</option>{validations.map(v=><option key={v.id} value={v.id}>{v.profile_name} · {v.id.slice(0,8)}</option>)}</select></label><label>预览名称<input aria-label="预览名称" required maxLength={120} value={title} onChange={e=>setTitle(e.target.value)}/></label><label>快照中的静态目录<input aria-label="快照中的静态目录" required value={folder} onChange={e=>setFolder(e.target.value)}/></label><label>相对目录的 HTML 入口<input aria-label="相对目录的 HTML 入口" required value={entry} onChange={e=>setEntry(e.target.value)}/></label><p className="collab-muted collab-small">使用相对资源地址；外部网络请求、表单、iframe 和服务工作线程禁用。生成目录 dist/build 默认不会进入快照，请把待评审页面保存在 preview 等可快照目录。</p><button className="collab-button" disabled={busy||!data.configured||!selected}>创建固定静态预览</button></form></details>}
 <label>撤销预览说明<input aria-label="撤销预览说明" value={reason} onChange={e=>setReason(e.target.value)} minLength={10} maxLength={2000}/></label>
 {data?.previews.map(p=><article key={p.id} className="collab-snapshot-card" aria-label={`预览 ${p.title}`}><h3>{p.title} · {names[p.status]}</h3><p className="collab-prewrap collab-small">快照：{p.snapshot_id}<br/>快照校验：{p.snapshot_hash}<br/>预览校验：{p.artifact_hash??'尚未生成'}<br/>到期：{new Date(p.expires_at).toLocaleString()} · {p.file_count??0} 个文件</p>{p.failure&&<p>{p.failure}</p>}{p.cleaned_at&&<p>临时预览文件已回收，原快照保留。</p>}
 {p.status==='ready'&&<div className="collab-form-actions"><button className="collab-button" disabled={busy} onClick={()=>void action(p,'open')}>打开独立预览</button>{(p.author_id===userId||data.role==='maintainer')&&<button className="collab-text-button" disabled={busy||reason.trim().length<10} onClick={()=>void action(p,'revoke')}>撤销此预览</button>}</div>}
 <details><summary>静态资源访问日志</summary>{data.logs.filter(l=>l.preview_id===p.id).slice(0,20).map(l=><p key={l.id} className="collab-small">{l.status} · {l.path} · {new Date(l.created_at).toLocaleTimeString()}</p>)}</details>
 </article>)}
 {opened&&<div><div className="collab-form-actions"><p>个人访问有效至 {new Date(opened.expiresAt).toLocaleTimeString()}</p><button className="collab-text-button" onClick={()=>setOpened(null)}>关闭预览</button></div><iframe title="固定检查点沙箱预览" src={opened.url} sandbox="allow-scripts" referrerPolicy="no-referrer" style={{width:'100%',height:480,border:'1px solid var(--border)',background:'white'}}/></div>}
 <ServicePreviews taskId={taskId} userId={userId}/>
 </section>;
}
