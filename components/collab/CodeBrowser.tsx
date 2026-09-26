"use client";
import { useEffect, useRef, useState } from "react";
import { collabApi } from "./api";
import { CodeFileTree, ReadonlyCode } from "./CodeExplorer";
import { ExplorerSlot, useFiles, workspaceFile } from "./WorkspaceFiles";
import type { RepositoryCodeTree, RepositoryCodeFile } from "@/lib/collab/repository-code";
import type { SnapshotCode, SnapshotFile } from "@/lib/collab/discussion-schema";
import type { Snapshot } from "./TaskSnapshots";
type Repository={id:string;name:string;base_sha:string};
export function CodeBrowser({projectId,preferredRepositoryId,taskId,snapshots=[],onEdit,enabled=true}:{projectId:string;preferredRepositoryId?:string;taskId?:string;snapshots?:Snapshot[];onEdit?:(id:string)=>void;enabled?:boolean}) {
 const sourceChosen=useRef(false);
 const workspace=useFiles(),scope=taskId??projectId;
 const active=workspace.active?.projectId===projectId&&workspace.active.taskId===taskId&&workspace.active.kind==="browse"?workspace.active:null;
 const [repositories,setRepositories]=useState<Repository[]>([]),[source,setSource]=useState("");
 const [paths,setPaths]=useState<string[]>([]),[revision,setRevision]=useState(""),[omitted,setOmitted]=useState(0),[error,setError]=useState(""),[loading,setLoading]=useState(false),[generation,setGeneration]=useState(0);
 const [text,setText]=useState<string|null>(null),[reading,setReading]=useState(false);
 const effectiveSource=active?.source??source,[kind,id]=effectiveSource.split(":"),selected=active?.path??"";
 useEffect(()=>{let alive=true;void collabApi<{repositories:Repository[]}>(`projects/${projectId}/repositories`).then(r=>{if(alive){setRepositories(r.repositories);setSource(old=>!sourceChosen.current&&preferredRepositoryId&&r.repositories.some(repo=>repo.id===preferredRepositoryId)?`repo:${preferredRepositoryId}`:old||(r.repositories[0]?`repo:${r.repositories[0].id}`:""));}}).catch(e=>{if(alive){setRepositories([]);setError(e.message);}});return()=>{alive=false;};},[projectId,preferredRepositoryId]);
 useEffect(()=>{
  let alive=true;setPaths([]);setRevision("");setText(null);setError("");setLoading(!!id);if(!id)return;
  void (async()=>{
   let files:string[],version:string,excluded=0;
   if(kind==="repo"){const data=await collabApi<RepositoryCodeTree>(`repositories/${id}/code`);files=data.files.map(f=>f.path);version=data.revision;excluded=data.omitted;}
   else {files=[];let offset:number|null=0;version="";do{const data:SnapshotCode=await collabApi(`snapshots/${id}/code?offset=${offset}`);files.push(...data.files.map(f=>f.path));version=data.manifestHash;offset=data.nextOffset;}while(offset!==null&&alive);}
   if(alive){setPaths(files);setRevision(version);setOmitted(excluded);}
  })().catch(e=>{if(alive)setError(e.message);}).finally(()=>{if(alive)setLoading(false);});
  return()=>{alive=false;};
 },[kind,id,generation]);
 useEffect(()=>{
  let alive=true;setText(null);setReading(false);if(!selected||!revision)return;setReading(true);setError("");
  const query=new URLSearchParams({path:selected,...(kind==="repo"?{revision}:{})});
  void collabApi<RepositoryCodeFile|SnapshotFile>(`${kind==="repo"?"repositories":"snapshots"}/${id}/code?${query}`).then(r=>{if(alive)setText(r.text);}).catch(e=>{if(alive)setError(e.message);}).finally(()=>{if(alive)setReading(false);});
  return()=>{alive=false;};
 },[selected,revision,kind,id]);
 useEffect(()=>{if(!id)return;let alive=true;const check=async()=>{try{await collabApi(`${kind==="repo"?"repositories":"snapshots"}/${id}/code${kind==="repo"&&revision?`?revision=${revision}`:""}`);}catch(e){if(alive){setPaths([]);setText(null);setRevision("");setError(e instanceof Error?e.message:"访问权限已变化");}}};const timer=setInterval(()=>{if(!document.hidden)void check();},10000);return()=>{alive=false;clearInterval(timer);};},[id,kind,revision]);
 const open=(file:string)=>{void workspace.open(workspaceFile({projectId,taskId,kind:"browse",source:effectiveSource,path:file}));};
 return <section className="wb-file-editor wb-code-surface" aria-label="代码浏览器">
 <ExplorerSlot scope={scope} enabled={enabled}><div className="wb-explorer-source"><label>代码来源<select aria-label="代码来源" value={effectiveSource} onChange={e=>{const next=e.target.value;void workspace.leave().then(ok=>{if(ok){sourceChosen.current=true;setSource(next);}});}}><option value="" disabled>选择仓库或快照</option>{repositories.map(r=><option key={r.id} value={`repo:${r.id}`}>{r.name} · 仓库基线</option>)}{snapshots.filter(s=>s.status==="ready").map(s=><option key={s.id} value={`snapshot:${s.id}`}>快照 · {s.note} · {s.id.slice(0,8)}</option>)}</select></label><button className="collab-text-button" onClick={()=>setGeneration(v=>v+1)} disabled={loading||!effectiveSource}>刷新文件树</button>{kind==="snapshot"&&onEdit&&<button className="collab-text-button" onClick={()=>onEdit(id)}>编辑此快照</button>}<p>{kind==="repo"?"仓库基线":"任务快照"}{revision&&` · ${revision.slice(0,8)}`} · 只读{omitted>0&&` · 已排除 ${omitted} 项`}</p>{error&&<p role="alert" className="collab-error">{error}</p>}</div><CodeFileTree files={paths} selected={selected} onOpen={open}/></ExplorerSlot>
 {selected?<><div className="wb-code-breadcrumb">{selected}<span>{kind==="repo"?"仓库基线":"任务快照"} · 只读</span></div>{error&&<p role="alert" className="collab-error">{error}</p>}{loading||reading?<p role="status">正在读取代码…</p>:text!==null?<ReadonlyCode text={text} filename={selected}/>:<p className="collab-muted">正文不可用，请刷新文件树或选择其他文件。</p>}</>:<div className="wb-file-empty"><h2>打开文件开始工作</h2><p>点击左侧文件树，文件会在顶部标签页打开。</p><button className="collab-button" onClick={workspace.showExplorer}>显示资源管理器</button>{!effectiveSource&&!loading&&<p>项目尚未连接代码仓库。</p>}</div>}
 </section>;
}
