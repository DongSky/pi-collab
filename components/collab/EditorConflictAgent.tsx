"use client";
import { useEffect,useRef,useState } from "react";
import { collabApi } from "./api";
import { useFiles } from "./WorkspaceFiles";
import type { EditorConflict } from "@/lib/collab/editor-schema";
export function EditorConflictAgent({userId,sessionId,documentId,conflict,onCandidate}:{userId:string;sessionId:string;documentId:string;conflict:EditorConflict;onCandidate:(text:string)=>void}){
 const workspace=useFiles(),projectId=workspace.active?.projectId;
 const [models,setModels]=useState<{id:string;name:string;enabled:boolean}[]>([]),[model,setModel]=useState(""),[busy,setBusy]=useState(false),[message,setMessage]=useState("");
 const [job,setJob]=useState<{taskId:string;projectId:string;runId:string}|null>(null);
 const request=useRef<{requestKey:string;modelId:string}|null>(null);
 useEffect(()=>{let alive=true;if(projectId)void collabApi<{models:{id:string;name:string;enabled:boolean}[]}>(`projects/${projectId}/models`).then(r=>{if(alive){setModels(r.models.filter(m=>m.enabled));setModel(r.models.find(m=>m.enabled)?.id??"");}}).catch(e=>{if(alive)setMessage(e.message);});return()=>{alive=false;};},[projectId]);
 const storageKey=`pi-collab:conflict-agent:${userId}:${sessionId}:${documentId}:${conflict.revision}`;
 useEffect(()=>{request.current=null;setJob(null);try{const saved=JSON.parse(sessionStorage.getItem(storageKey)??"null");if(saved&&saved.local===conflict.local){request.current=saved.request;setJob(saved.job??null);}}catch{}},[storageKey,conflict.local]);
 const remember=(value:typeof job)=>{sessionStorage.setItem(storageKey,JSON.stringify({local:conflict.local,request:request.current,job:value}));};
 async function start(){setBusy(true);setMessage("");try{request.current??={requestKey:crypto.randomUUID(),modelId:model};remember(null);const result=await collabApi<{taskId:string;projectId:string;runId:string}>(`editors/${sessionId}/conflict-agent`,{...request.current,documentId,revision:conflict.revision,baseToken:conflict.baseToken,base:conflict.base,local:conflict.local,remote:conflict.remote});setJob(result);remember(result);setMessage("Agent 已进入独立任务；共享文件仍暂停保存。完成后读取候选，再由你确认。");}catch(e){setMessage(`请求未完成，可重试同一请求：${e instanceof Error?e.message:"未知错误"}`);}finally{setBusy(false);}}
 async function read(){if(!job)return;setBusy(true);try{const result=await collabApi<{status:string;text?:string}>(`editors/${sessionId}/conflict-agent`,{taskId:job.taskId,documentId},"PUT");if(result.status==="ready"&&result.text!==undefined){onCandidate(result.text);setMessage("候选已载入上方合并结果，尚未保存。");}else setMessage(`Agent 状态：${result.status}。可打开任务查看进度，稍后读取候选。`);}catch(e){setMessage(e instanceof Error?e.message:"读取候选失败");}finally{setBusy(false);}}
 return <div className="wb-merge-agent"><p>让 Agent 修复：使用项目模型和额度，在独立任务内生成候选；不会直接覆盖共享文件。</p><label>修复模型<select aria-label="冲突修复模型" value={model} onChange={e=>setModel(e.target.value)} disabled={busy||!!request.current}>{models.map(m=><option key={m.id} value={m.id}>{m.name}</option>)}</select></label><button disabled={busy||!model||!!job} onClick={()=>void start()}>{busy&&!job?"正在提交…":request.current&&!job?"重试 Agent 请求":"让 Agent 修复"}</button>{job&&<><a href={`/?project=${job.projectId}&task=${job.taskId}`} target="_blank" rel="noopener noreferrer">在新窗口查看修复任务</a><button disabled={busy} onClick={()=>void read()}>读取 Agent 候选</button></>}{message&&<p role="status">{message}</p>}</div>;
}
