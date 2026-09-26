"use client";
import { useEffect,useRef,useState,type InputHTMLAttributes } from "react";
import { collabApi } from "./api";
import { folderExclusion,FOLDER_COUNT_LIMIT,FOLDER_FILE_LIMIT,FOLDER_TOTAL_LIMIT,type FolderImportResult } from "@/lib/collab/folder-import-schema";
const directoryAttributes={webkitdirectory:"",directory:""} as InputHTMLAttributes<HTMLInputElement>;
export function OpenFolder({projectId,projectName,onClose,onOpened}:{projectId:string;projectName:string;onClose:()=>void;onOpened:(result:FolderImportResult)=>Promise<void>}){
 const dialog=useRef<HTMLDialogElement>(null),picker=useRef<HTMLInputElement>(null);
 const [name,setName]=useState(""),[files,setFiles]=useState<{path:string;file:File}[]>([]),[excluded,setExcluded]=useState<{path:string;reason:string}[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState(""),[result,setResult]=useState<FolderImportResult|null>(null);
 const pending=useRef<{requestKey:string;name:string;files:{path:string;data:string}[]}|null>(null);
 useEffect(()=>{dialog.current?.showModal();},[]);
 function select(list:FileList|null){
  if(!list)return;setError("");setResult(null);pending.current=null;
  const next:{path:string;file:File}[]=[],omitted:{path:string;reason:string}[]=[];let total=0;
  const chosen=Array.from(list);setName(chosen[0]?.webkitRelativePath.split("/")[0]??"");
  for(const file of chosen){const path=file.webkitRelativePath.split("/").slice(1).join("/"),reason=folderExclusion(path)??(file.size>FOLDER_FILE_LIMIT?"超过单文件 2 MiB 限制":null);if(reason){omitted.push({path,reason});continue;}next.push({path,file});total+=file.size;}
  if(next.length>FOLDER_COUNT_LIMIT||total>FOLDER_TOTAL_LIMIT){setFiles([]);setExcluded(omitted);setError("文件夹过大：一次最多 2,000 个文件、合计 32 MiB。请选择更小的项目目录。");return;}
  setFiles(next);setExcluded(omitted);if(!next.length)setError("没有可导入文件，请选择包含代码文件的目录。");
 }
 async function submit(){if(busy)return;setBusy(true);setError("");try{
  if(!pending.current){const encoded=[];for(const {path,file} of files){const bytes=new Uint8Array(await file.arrayBuffer());let binary="";for(let offset=0;offset<bytes.length;offset+=8192)binary+=String.fromCharCode(...bytes.subarray(offset,offset+8192));encoded.push({path,data:btoa(binary)});}pending.current={requestKey:crypto.randomUUID(),name:name.trim(),files:encoded};}
  const opened=result??await collabApi<FolderImportResult>(`projects/${projectId}/folders`,pending.current);setResult(opened);
  await onOpened(opened);onClose();
 }catch(e){setError(e instanceof Error?e.message:"打开文件夹失败；可重试同一请求");}finally{setBusy(false);}}
 return <dialog ref={dialog} className="wb-folder-dialog" aria-label="打开工作文件夹" onCancel={e=>{if(busy)e.preventDefault();else onClose();}}><form onSubmit={e=>{e.preventDefault();void submit();}}><h2>打开工作文件夹</h2><p>选择这台电脑上的项目目录，导入到「{projectName}」并创建可编辑的协作副本。项目成员可以访问导入的内容。</p><input hidden ref={picker} type="file" multiple {...directoryAttributes} aria-label="选择工作文件夹" onChange={e=>select(e.target.files)} disabled={busy||!!pending.current}/><button type="button" className="collab-button" disabled={busy||!!pending.current} onClick={()=>picker.current?.click()}>选择本机文件夹…</button><label>工作文件夹名称<input aria-label="工作文件夹名称" value={name} onChange={e=>setName(e.target.value)} maxLength={120} required disabled={busy||!!pending.current}/></label><p className="collab-muted">原目录保持不变。导入当前文件（含未提交修改），排除 Git 历史、凭据和依赖目录；协作副本建立新的 Git 基线。</p>{files.length>0&&<details open><summary>将导入 {files.length} 个文件 · {(files.reduce((n,f)=>n+f.file.size,0)/1024).toFixed(1)} KiB</summary><ul>{files.slice(0,100).map(f=><li key={f.path}>{f.path}</li>)}</ul>{files.length>100&&<p>其余 {files.length-100} 项未展开。</p>}</details>}{excluded.length>0&&<details><summary>已排除 {excluded.length} 项</summary><ul>{excluded.slice(0,100).map((f,i)=><li key={i}>{f.path} · {f.reason}</li>)}</ul></details>}{error&&<p className="collab-error" role="alert">{error}</p>}<footer><button type="button" className="collab-button" disabled={busy} onClick={onClose}>取消</button><button className="collab-button primary" disabled={busy||!files.length||!name.trim()}>{busy?"正在准备工作区…":result?"打开已导入的文件夹":pending.current?"重试同一导入请求":"导入并打开"}</button></footer></form></dialog>;
}
