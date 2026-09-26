"use client";
import {useCallback,useEffect,useState} from "react";
import {EnvironmentRecipe} from "./EnvironmentRecipe";
import {collabApi} from "./api";
type Environment={workspace_id:string;title:string;resource_id:string;resource_status:string;port:number|null;state:string;version:number;workspace_status:string};
export function WorkspaceEnvironments({projectId}:{projectId:string}){
 const [data,setData]=useState<{canManage:boolean;environments:Environment[]}|null>(null),[error,setError]=useState(""),[selected,setSelected]=useState<Environment|null>(null),[busy,setBusy]=useState(false),[notice,setNotice]=useState("");
 const load=useCallback(async()=>{try{setData(await collabApi(`projects/${projectId}/environments`));}catch(e){setError(e instanceof Error?e.message:"读取环境失败");}},[projectId]);
 useEffect(()=>{void load();const timer=setInterval(()=>{if(!document.hidden)void load();},5000);return()=>clearInterval(timer);},[load]);
 return <section aria-label="工作区测试环境"><EnvironmentRecipe projectId={projectId}/><h3>工作区测试环境</h3><p>每个 AI 工作区独享测试库命名空间和分配端口。测试数据在确认工作区停止 24 小时后回收；代码快照不包含测试库。数据库通过协作工具访问，无需共享密码。</p><p className="collab-small">原生端口只协调本实例管理的任务；启动会检查外部占用。应用需使用 PORT，仅绑定 127.0.0.1。端口分配不代表预览已启动。</p>{error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
 {data?.environments.map(e=><article className="collab-result-card" key={e.workspace_id}><strong>{e.title}</strong><p>{({active:"已分配",resetting:"等待重置",reclaiming:"等待回收",released:"已回收"} as Record<string,string>)[e.state]} · 测试库 {({ready:"就绪",requested:"准备中",disabled:"停用"} as Record<string,string>)[e.resource_status]} · 端口 {e.port??"已释放"}</p><p className="collab-git-identity collab-small">工作区 {e.workspace_id}<br/>测试资源 {e.resource_id}</p>{data.canManage&&e.state==="active"&&<button className="collab-text-button" onClick={()=>{setSelected(e);setError("");}}>管理此测试环境</button>}</article>)}
 {data&&!data.environments.length&&<p>AI 启动时自动创建独立测试环境。</p>}
 {selected&&<form className="collab-form" onSubmit={async event=>{event.preventDefault();const f=new FormData(event.currentTarget);setBusy(true);setError("");try{await collabApi(`workspaces/${selected.workspace_id}/environment`,{expectedVersion:selected.version,action:f.get("action"),reason:f.get("reason"),acknowledgeLoss:true,idempotencyKey:crypto.randomUUID()});setSelected(null);setNotice("操作已排队，资源服务完成后自动更新。");await load();}catch(e){setError(e instanceof Error?e.message:"操作失败");}finally{setBusy(false);}}}>
 <h4>{selected.title}</h4><label>环境操作<select name="action" aria-label="环境操作"><option value="reset">清空并重建测试库</option>{selected.workspace_status==="stopped"&&<option value="reclaim">回收测试库与端口</option>}</select></label><p>须先让 AI 释放数据库租约并结束 SQL 作业；回收还要求工作区已确认停止。隔离中的工作区不能强行释放。</p><label>操作原因<textarea name="reason" minLength={10} maxLength={2000} required/></label><label><input type="checkbox" required/>确认删除该测试库数据；已保存所需数据</label><button className="collab-button" disabled={busy}>提交环境操作</button><button className="collab-text-button" type="button" disabled={busy} onClick={()=>setSelected(null)}>取消</button></form>}
 </section>;
}
