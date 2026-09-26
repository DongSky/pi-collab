"use client";
import { Activity, useState } from "react";
import { CodeBrowser } from "./CodeBrowser";
import { CollaborativeEditor } from "./CollaborativeEditor";
import { TaskSnapshots, type Snapshot } from "./TaskSnapshots";
import { ExplorerSlot, useFiles } from "./WorkspaceFiles";
import { collabApi } from "./api";
export function TaskCodeWorkspace({projectId,userId,taskId,taskVersion,snapshots,canManage,onHandoff,run,refresh,enabled=true}:{enabled?:boolean;projectId:string;userId:string;taskId:string;taskVersion:number;snapshots:Snapshot[];canManage:boolean;onHandoff:(version:string,source:string,kind?:"ai"|"terminal")=>void;run?:{repository_id?:string;id:string;revision:string;status:string;workspace_status:string};refresh:()=>Promise<void>}) {
 const workspace=useFiles();
 const [chosenMode,setMode]=useState<"browse"|"edit">("browse"),[editorId,setEditorId]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState("");
 const file=workspace.active?.taskId===taskId?workspace.active:null;
 const mode=file?(file.kind==="shared"?"edit":"browse"):chosenMode;
 async function edit(snapshotId:string){if(busy)return;setBusy(true);setError("");try{const result=await collabApi<{id:string}>(`tasks/${taskId}/editor`,{snapshotId,expectedVersion:taskVersion});if(await workspace.leave()){setEditorId(result.id);setMode("edit");}}catch(e){setError(e instanceof Error?e.message:"打开编辑器失败");}finally{setBusy(false);}}
 return <div className="wb-task-code"><ExplorerSlot scope={taskId} enabled={enabled}><div className="wb-code-mode"><button aria-pressed={mode==="browse"} onClick={()=>{void workspace.leave().then(ok=>{if(ok)setMode("browse");});}}>浏览项目代码</button><button aria-pressed={mode==="edit"} onClick={()=>{void workspace.leave().then(ok=>{if(ok)setMode("edit");});}}>多人代码编辑器</button>{busy&&<span role="status">正在打开草稿…</span>}</div>{error&&<p role="alert" className="collab-error">{error}</p>}</ExplorerSlot>
 <Activity mode={mode==="browse"?"visible":"hidden"}><CodeBrowser preferredRepositoryId={run?.repository_id} enabled={enabled&&mode==="browse"} taskId={taskId} projectId={projectId} snapshots={snapshots} onEdit={canManage&&!busy?id=>void edit(id):undefined}/>
 <ExplorerSlot scope={taskId} enabled={enabled&&mode==="browse"}><details className="wb-code-capture"><summary>查看本次运行的修改 / 准备编辑</summary><p className="collab-small">仓库基线始终可读。查看运行产生的完整文件时，先在运行停止后保存代码快照，再从“代码来源”选择它；点击“编辑此快照”即可进入多人编辑器。</p><TaskSnapshots snapshots={snapshots} run={run} canCapture={canManage} refresh={refresh}/></details></ExplorerSlot></Activity>
 <Activity mode={mode==="edit"?"visible":"hidden"}><CollaborativeEditor onActivate={()=>setMode("edit")} projectId={projectId} enabled={enabled&&mode==="edit"} key={editorId||taskId} initialSession={editorId} userId={userId} taskId={taskId} taskVersion={taskVersion} snapshots={snapshots} canManage={canManage} onHandoff={onHandoff}/></Activity>
 </div>;
}
