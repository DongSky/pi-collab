"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { CommandPalette } from "./WorkbenchChrome";
import { CodeFileTree, ReadonlyCode } from "./CodeExplorer";
import { ExplorerSlot, useFiles, workspaceFile } from "./WorkspaceFiles";
import { EditorFileSearch } from "./EditorFileActions";
import { collabApi, CollabApiError } from "./api";
import { SharedCodeEditor, downloadEditorText, type SharedEditorHandle } from "./SharedCodeEditor";
import type { EditorSaveState } from "@/lib/collab/editor-save-state";
import type { EditorDetail, EditorSession, EditorSync } from "@/lib/collab/editor-schema";
import type { Snapshot } from "./TaskSnapshots";
const names={editing:"多人编辑中",frozen:"已冻结 · 待交接",handed_off:"已交给运行工作区",archived:"已归档"};
export function CollaborativeEditor({projectId,userId,taskId,taskVersion,snapshots,canManage,onHandoff,onActivate,initialSession="",enabled=true}:{projectId:string;onActivate?:()=>void;enabled?:boolean;initialSession?:string;userId:string;taskId:string;taskVersion:number;snapshots:Snapshot[];canManage:boolean;onHandoff:(versionId:string,snapshotId:string,kind?:"ai"|"terminal")=>void}){
 const [quickOpen,setQuickOpen]=useState(false);
 useEffect(()=>{if(!enabled)return;const keyboard=(e:KeyboardEvent)=>{if((e.metaKey||e.ctrlKey)&&!e.shiftKey&&!e.altKey&&e.key.toLowerCase()==="p"){e.preventDefault();setQuickOpen(true);}};window.addEventListener("keydown",keyboard);return()=>window.removeEventListener("keydown",keyboard);},[enabled]);
 const workspace=useFiles(),{registerGuard,reportStatus}=workspace;
 const active=workspace.active?.taskId===taskId&&workspace.active.kind==="shared"?workspace.active:null;
 const [sessions,setSessions]=useState<EditorSession[]>([]),[chosen,setChosen]=useState(initialSession),[source,setSource]=useState(""),[detail,setDetail]=useState<EditorDetail|null>(null),[documentId,setDocumentId]=useState(""),[newPath,setNewPath]=useState(""),[movePath,setMovePath]=useState(""),[note,setNote]=useState(""),[error,setError]=useState(""),[busy,setBusy]=useState(false),[pending,setPending]=useState(false),[readOnly,setReadOnly]=useState<string|null>(null);
 const selected=active?.source??chosen,activeFile=active?.path??"";
 const [loadedFile,setLoadedFile]=useState("");
 const activeId=active?.id;
 const statusChanged=useCallback((state:EditorSaveState)=>{if(activeId)reportStatus(activeId,state);},[activeId,reportStatus]);
 const reportFailure=useRef<(message:string)=>void>(()=>{});
 reportFailure.current=(message:string)=>{if(activeId)reportStatus(activeId,{...(workspace.statuses[activeId]??{dirty:false}),phase:"error",message});};
 const editor=useRef<SharedEditorHandle>(null),selection=useRef(selected),requestSequence=useRef(0);
 selection.current=selected;
 const invalidateRequests=useCallback(()=>{++requestSequence.current;},[]);
 const refresh=useCallback(async()=>{const sequence=++requestSequence.current;const list=await collabApi<{sessions:EditorSession[]}>(`tasks/${taskId}/editor`);if(sequence!==requestSequence.current||selection.current!==selected)return;setSessions(list.sessions);if(selected){const next=await collabApi<EditorDetail>(`editors/${selected}`);if(sequence===requestSequence.current&&selection.current===selected)setDetail(next);}else if(list.sessions[0])setChosen(list.sessions[0].id);},[taskId,selected]);
 useEffect(()=>{let alive=true;const load=()=>{if(alive)void refresh().catch(e=>{if(alive){setError(e.message);reportFailure.current(e.message);if(e instanceof CollabApiError&&[401,403,404].includes(e.status)){setDetail(null);setDocumentId("");setReadOnly(null);}}});};load();const timer=setInterval(load,5000);return()=>{alive=false;invalidateRequests();clearInterval(timer);};},[refresh,invalidateRequests]);
 const current=detail?.session.id===selected?detail:null;
 const readSnapshot=current?.session.snapshot_id;
 const documentMode=current?(current.canWrite||current.documents.some(d=>d.path===activeFile)?"shared":"snapshot"):"";
 useEffect(()=>{let alive=true;setDocumentId("");setReadOnly(null);setPending(false);if(!selected||!activeFile||!readSnapshot)return;
  void (async()=>{if(documentMode==="snapshot"){const r=await collabApi<{text:string}>(`snapshots/${readSnapshot}/code?path=${encodeURIComponent(activeFile)}`);if(alive){setReadOnly(r.text);statusChanged({phase:"readonly",dirty:false,readOnlyReason:"无写入权限或草稿已冻结"});}}else{const r=await collabApi<{id:string}>(`editors/${selected}/documents`,{path:activeFile});if(alive){setDocumentId(r.id);setLoadedFile(`${selected}:${activeFile}`);}}})().catch(e=>{if(alive){setError(e.message);reportFailure.current(e.message);}});return()=>{alive=false;};
 },[selected,activeFile,readSnapshot,documentMode,statusChanged]);
 useEffect(()=>{if(!activeFile||!enabled)return;return registerGuard(async()=>{await editor.current?.flush();});},[activeFile,enabled,registerGuard]);
 async function action(work:()=>Promise<void>){setBusy(true);setError("");try{await work();await refresh();}catch(e){setError(e instanceof Error?e.message:"操作失败");}finally{setBusy(false);}}
 function openFile(path:string,line?:number,column?:number){return workspace.open(workspaceFile({projectId,taskId,kind:"shared",source:selected,path,line,column,navigation:Date.now()}));}
 async function createFile(){await action(async()=>{await editor.current?.flush();const path=newPath.trim();await collabApi(`editors/${selected}/documents`,{path,create:true});openFile(path);setNewPath("");});}
 function synced(result:EditorSync){setDetail(old=>old&&old.session.id===result.session.id?{...old,session:result.session,canWrite:old.canWrite&&result.session.state==="editing",documents:old.documents.map(d=>d.id===result.document.id?result.document:d)}:old);}
 async function checkpoint(command:"checkpoint"|"handoff"|"reopen"|"archive"|"copy",kind?:"ai"|"terminal"){
  await action(async()=>{await editor.current?.flush();const latest=await collabApi<EditorDetail>(`editors/${selected}`);const result=await collabApi<{versionId:string|null;snapshotId:string;sessionId?:string}>(`editors/${selected}`,{action:command,expectedVersion:latest.session.version,note});if(command==="handoff"&&result.versionId)onHandoff(result.versionId,result.snapshotId,kind);if(command==="copy"&&result.sessionId){if(await workspace.leave()){setChosen(result.sessionId);setDetail(null);onActivate?.();}}setNote("");});
 }
 const files=current?[...new Set([...current.files,...current.documents.map(d=>d.path)])].sort():[];
 return <section className="wb-file-editor wb-code-surface" aria-label="实时共编">
 {quickOpen&&enabled&&<CommandPalette label="快速打开文件" onClose={()=>setQuickOpen(false)} commands={files.filter(path=>!current?.documents.some(d=>d.path===path&&d.deleted)).map(path=>({id:path,label:path.split("/").at(-1)!,detail:path,run:()=>void openFile(path)}))}/>}
 <ExplorerSlot scope={taskId} enabled={enabled}>
 <div className="wb-explorer-source"><label>共享草稿<select aria-label="已有草稿" value={selected} disabled={busy||pending} onChange={e=>{const id=e.target.value;void workspace.leave().then(ok=>{if(ok){setChosen(id);setDetail(null);}});}}><option value="">选择草稿</option>{sessions.map(s=><option key={s.id} value={s.id}>{names[s.state]} · {new Date(s.created_at).toLocaleString()}</option>)}</select></label>
 {canManage&&<details className="wb-editor-create" open={!selected}><summary>从快照打开新草稿</summary><label>来源快照<select aria-label="共编来源快照" value={source} onChange={e=>setSource(e.target.value)}><option value="">选择停止后的快照</option>{snapshots.filter(s=>s.status==="ready").map(s=><option key={s.id} value={s.id}>{s.note} · {s.id.slice(0,8)}</option>)}</select></label><button type="button" disabled={!source||busy||pending} onClick={()=>void action(async()=>{const result=await collabApi<{id:string}>(`tasks/${taskId}/editor`,{snapshotId:source,expectedVersion:taskVersion});if(await workspace.leave()){setChosen(result.id);setDetail(null);}})}>打开共编草稿</button></details>}
 {current&&<p role="status">{names[current.session.state]} · 版本 {current.session.version}{pending?" · 待同步":""}</p>}
 {error&&<p className="collab-error" role="alert">{error}</p>}
 </div>
 {current&&<EditorFileSearch key={selected} sessionId={selected} canWrite={current.canWrite} onOpen={openFile} flush={async()=>{await editor.current?.flush();}}/>}
 <button className="wb-quick-open" title="Ctrl / ⌘ P" onClick={()=>setQuickOpen(true)}>快速打开文件 ⌘ P</button>
 <CodeFileTree deleted={current?.documents.filter(d=>d.deleted).map(d=>d.path)} files={files} selected={activeFile} disabled={busy} onOpen={openFile}/>
 {current&&<details className="wb-explorer-actions"><summary>共编与版本</summary>
 <button className="collab-text-button" disabled={busy} onClick={()=>void action(async()=>{await editor.current?.flush();const response=await fetch(`/api/collab/editors/${selected}/files`);if(!response.ok)throw new Error("导出失败，请核对权限或文件大小。");const url=URL.createObjectURL(await response.blob()),link=document.createElement('a');link.href=url;link.download='pi-collab-draft.zip';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);workspace.setNotice("已发起草稿 ZIP 下载，请在浏览器确认保存。包含最新保存内容和新文件，排除已删除文件。");})}>下载整个工作文件夹 ZIP</button>
 {documentId&&current.canWrite&&<form className="wb-explorer-new" onSubmit={e=>{e.preventDefault();void action(async()=>{await editor.current?.flush();const latest=await collabApi<EditorDetail>(`editors/${selected}`),source=latest.documents.find(d=>d.id===documentId);if(!source)throw new Error("请重新打开来源文件");await collabApi(`editors/${selected}/documents`,{documentId,path:movePath.trim(),expectedRevision:source.revision},"PATCH");if(active)await workspace.close(active.id);await openFile(movePath.trim());setMovePath("");});}}><input aria-label="重命名或移动到" placeholder="重命名 / 移动到 src/new-name.ts" value={movePath} onChange={e=>setMovePath(e.target.value)} required/><button disabled={busy||!movePath.trim()}>重命名 / 移动</button></form>}
 {current.canWrite&&<div className="wb-explorer-new"><input aria-label="新建文件路径" placeholder="src/example.ts" value={newPath} onChange={e=>setNewPath(e.target.value)}/><button disabled={busy||!newPath.trim()} onClick={()=>void createFile()}>新建文件</button></div>}
 {documentId&&current.canWrite&&<button className="collab-text-button" disabled={busy||pending} onClick={()=>void action(async()=>{await editor.current?.flush();const latest=await collabApi<EditorDetail>(`editors/${selected}`),d=latest.documents.find(d=>d.id===documentId)!;await collabApi(`editors/${selected}/documents`,{documentId,clientId:crypto.getRandomValues(new Uint32Array(1))[0],deleted:!d.deleted,expectedRevision:d.revision},"PUT");setDocumentId("");await workspace.leave();})}>{current.documents.find(d=>d.id===documentId)?.deleted?"恢复当前文件":"删除当前文件"}</button>}
 {current.session.state==="handed_off"&&<p>此草稿已交给运行工作区。运行结束后可复制原草稿，或从运行快照继续。</p>}
 {current.canManage&&["editing","frozen","handed_off"].includes(current.session.state)&&<div className="wb-explorer-version"><label>版本 / 交接说明<input value={note} onChange={e=>setNote(e.target.value)} maxLength={2000}/></label>{current.session.state==="handed_off"?<button disabled={busy||!note.trim()} onClick={()=>void checkpoint("copy")}>复制已交接草稿继续编辑</button>:current.session.state==="editing"?<><button disabled={busy||!note.trim()} onClick={()=>void checkpoint("checkpoint")}>保存版本</button><button disabled={busy||!note.trim()} onClick={()=>void checkpoint("handoff")}>冻结并选择交给 AI</button><button disabled={busy||!note.trim()} onClick={()=>void checkpoint("handoff","terminal")}>在终端运行此版本</button></>:<button disabled={busy||!note.trim()} onClick={()=>void checkpoint("reopen")}>重新开放编辑</button>}{current.session.state!=="handed_off"&&<button disabled={busy||!note.trim()} onClick={()=>void checkpoint("archive")}>归档并释放任务</button>}</div>}
 {current.versions.map(v=><div key={v.id}><p>版本 {v.version} · {v.note}</p><button className="collab-text-button" onClick={()=>downloadEditorText(`draft-${v.id}.json`,JSON.stringify(v.payload,null,2))}>导出版本</button>{current.canManage&&current.session.state==="frozen"&&BigInt(v.version)+BigInt(1)===BigInt(current.session.version)&&<button className="collab-text-button" onClick={()=>onHandoff(v.id,current.session.snapshot_id)}>选择此版交给 AI</button>}</div>)}
 </details>}
 </ExplorerSlot>
 {activeFile?<><div className="wb-code-breadcrumb">{activeFile}<span>共享草稿{current?` · ${names[current.session.state]}`:""}</span></div>{error&&<p className="collab-error" role="alert">{error}</p>}{documentId&&loadedFile===`${selected}:${activeFile}`&&<SharedCodeEditor key={`${selected}:${documentId}`} ref={editor} userId={userId} sessionId={selected} documentId={documentId} filename={activeFile} workspaceVersion={current?.session.version??"0"} reveal={active?.line?{line:active.line,column:active.column??1,navigation:active.navigation??0}:undefined} onNavigate={openFile} onPending={setPending} onSync={synced} onStatus={statusChanged} onSavedAs={async path=>{await refresh();const opened=await openFile(path);workspace.setNotice(`已另存为 ${path} · 当前任务共享草稿${opened?" · 已打开新标签":" · 可从文件树打开"}`);}}/>}{readOnly!==null&&<ReadonlyCode text={readOnly} filename={activeFile}/ >}{!documentId&&readOnly===null&&<p role="status">正在打开文件…</p>}</>:<div className="wb-file-empty"><h2>多人代码编辑器</h2><p>从左侧选择共享草稿和文件，代码将在独立标签页打开。</p><button className="collab-button" onClick={workspace.showExplorer}>显示资源管理器</button></div>}
 </section>;
}
