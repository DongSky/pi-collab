"use client";
import { createContext, useCallback, useContext, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";

import type { EditorSaveState } from "@/lib/collab/editor-save-state";
import { restoreWorkspaceFiles, type WorkspaceFile } from "@/lib/collab/workspace-file-tabs";
export { workspaceFile, type WorkspaceFile } from "@/lib/collab/workspace-file-tabs";
export function useWorkspaceFiles(activate:(file:WorkspaceFile)=>void) {
 const [tabs,setTabs]=useState<WorkspaceFile[]>([]),[active,setActive]=useState<WorkspaceFile|null>(null),[error,setError]=useState("");
 const [statuses,setStatuses]=useState<Record<string,EditorSaveState>>({}),[notice,setNotice]=useState("");
 const reportStatus=useCallback((id:string,state:EditorSaveState)=>{if(!state.dirty&&["saved","readonly"].includes(state.phase))setError("");setStatuses(old=>JSON.stringify(old[id])===JSON.stringify(state)?old:{...old,[id]:state});},[]);
 const [aiRequest,setAiRequest]=useState<{fileId:string;text:string;id:number}|null>(null);
 const consumeAiRequest=useCallback((id:number)=>setAiRequest(old=>old?.id===id?null:old),[]);
 const askAi=useCallback((text:string)=>{if(active)setAiRequest({fileId:active.id,text,id:Date.now()});},[active]);
 const [agentHost,setAgentHost]=useState<HTMLDivElement|null>(null);
 const [aiHost,setAiHost]=useState<HTMLDivElement|null>(null);
 const [sidebarHost,setSidebarHost]=useState<HTMLDivElement|null>(null);
 const guard=useRef<null|(()=>Promise<void>)>(null),switching=useRef(false),generation=useRef(0);
 const registerGuard=useCallback((flush:()=>Promise<void>)=>{guard.current=flush;return()=>{if(guard.current===flush)guard.current=null;};},[]);
 const transition=useCallback(async(work:()=>void)=>{if(switching.current)return false;switching.current=true;const version=generation.current;setError("");try{await guard.current?.();if(version!==generation.current)return false;work();return true;}catch(e){setError(e instanceof Error?e.message:"文件尚未同步，请稍后重试。");return false;}finally{switching.current=false;}},[]);
 const open=useCallback((file:WorkspaceFile)=>transition(()=>{setTabs(old=>old.some(t=>t.id===file.id)?old:[...old,file]);setActive(file);activate(file);}),[activate,transition]);
 const reorder=useCallback((source:string,target:string)=>{setTabs(old=>{const from=old.findIndex(f=>f.id===source),to=old.findIndex(f=>f.id===target);if(from<0||to<0||from===to)return old;const next=[...old];const [file]=next.splice(from,1);next.splice(to,0,file);return next;});},[]);
 const leave=useCallback(()=>transition(()=>setActive(null)),[transition]);
 const close=useCallback(async(id:string)=>{const next=tabs.filter(t=>t.id!==id);if(active?.id!==id){setTabs(next);return;}await transition(()=>{setTabs(next);const last=next.at(-1)??null;setActive(last);if(last)activate(last);});},[active,tabs,activate,transition]);
 const reset=useCallback(()=>{generation.current++;setStatuses({});setNotice("");setTabs([]);setActive(null);guard.current=null;setError("");},[]);
 const restore=useCallback((raw:string|null,projectId:string,taskIds:string[])=>{const saved=restoreWorkspaceFiles(raw,projectId,taskIds);setTabs(saved.tabs);setActive(saved.active);if(saved.active)activate(saved.active);},[activate]);
 const forgetTask=useCallback((taskId:string)=>{setTabs(old=>old.filter(f=>f.taskId!==taskId));setActive(old=>old?.taskId===taskId?null:old);},[]);
 return {agentHost,setAgentHost,aiRequest,askAi,consumeAiRequest,statuses,reportStatus,notice,setNotice,tabs,active,open,reorder,leave,close,reset,restore,forgetTask,registerGuard,sidebarHost,setSidebarHost,aiHost,setAiHost,error};
}
type FilesContext=ReturnType<typeof useWorkspaceFiles>&{scope:string;showExplorer:()=>void;openFolder:()=>void;canOpenFolder:boolean};
export const WorkspaceFilesContext=createContext<FilesContext|null>(null);
export function useFiles(){const value=useContext(WorkspaceFilesContext);if(!value)throw new Error("File workspace requires TeamShell");return value;}
/** Keep the explorer in the shell's left column; the editor stays in the central surface. */
export function ExplorerSlot({scope,enabled=true,children}:{scope:string;enabled?:boolean;children:ReactNode}) {
 const files=useFiles();return enabled&&files.scope===scope&&files.sidebarHost?createPortal(children,files.sidebarHost):null;
}

export function EditorAiSlot({sessionId,path,children}:{sessionId:string;path:string;children:ReactNode}){const files=useFiles();return files.active?.kind==="shared"&&files.active.source===sessionId&&files.active.path===path&&files.aiHost?createPortal(children,files.aiHost):null;}

const desktopQuery="(min-width:1001px)";
const subscribeDesktop=(notify:()=>void)=>{const media=window.matchMedia(desktopQuery);media.addEventListener("change",notify);return()=>media.removeEventListener("change",notify);};
export function useDesktopAgentDock(){return useSyncExternalStore(subscribeDesktop,()=>window.matchMedia(desktopQuery).matches,()=>false);}
/** Desktop agents span the shell height; narrow screens retain the inline overlay. */
export function AgentDock({enabled,children}:{enabled:boolean;children:ReactNode}){const {agentHost}=useFiles();return enabled&&agentHost?createPortal(children,agentHost):children;}
