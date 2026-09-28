"use client";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import * as Y from "yjs";
import { Awareness, applyAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";
import { syntaxHighlighting } from "@codemirror/language";
import { classHighlighter } from "@lezer/highlight";
import { EditorPreferences, preferenceExtensions, useEditorPreferences } from "./EditorPreferences";
import { EditorLanguagePanel } from "./EditorLanguagePanel";
import { semanticExtensions, supportsSemantic } from "./editor-language";
import type { LanguageRequest } from "@/lib/collab/language-schema";
import { editorTools } from "./editor-tools";
import { openSearchPanel, gotoLine } from "@codemirror/search";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import { EditorMergeDiff } from "./EditorMergeDiff";
import { EditorAiPanel, type EditorAiBase } from "./EditorAiPanel";
import { EditorAiSlot, useFiles } from "./WorkspaceFiles";
import { EditorConflictAgent } from "./EditorConflictAgent";
import { collabApi, CollabApiError } from "./api";
import { draftKey, readDrafts, saveDraft, removeDraft, type DraftScope, type EditorDraft } from "@/lib/collab/editor-drafts";
import { acknowledgedEditorState, editorSaveLabel, editorSaveDescription, type EditorSaveState } from "@/lib/collab/editor-save-state";
import type { EditorSync, EditorConflict, EditorWriteback } from "@/lib/collab/editor-schema";
const encode=(bytes:Uint8Array)=>{let s="";for(const b of bytes)s+=String.fromCharCode(b);return btoa(s);};
const decode=(s:string)=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
export function downloadEditorText(name:string,text:string){const a=document.createElement("a"),url=URL.createObjectURL(new Blob([text],{type:"text/plain;charset=utf-8"}));a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
export type SharedEditorHandle={flush:()=>Promise<void>};
export const SharedCodeEditor=forwardRef<SharedEditorHandle,{userId:string;sessionId:string;documentId:string;filename?:string;workspaceVersion:string;reveal?:{line:number;column:number;navigation:number};onPending:(pending:boolean)=>void;onSync:(result:EditorSync)=>void;onStatus:(state:EditorSaveState)=>void;onSavedAs:(path:string)=>Promise<void>;onNavigate:(path:string,line:number,column:number)=>void}>(function SharedCodeEditor({userId,sessionId,documentId,filename="",workspaceVersion,reveal,onPending,onSync,onStatus,onSavedAs,onNavigate},ref){
 const fileWorkspace=useFiles();
 const preferences=useEditorPreferences(),preferencesRef=useRef(preferences.value),preferenceCompartment=useRef(new Compartment());
 preferencesRef.current=preferences.value;
 const semanticCommand=useRef<(action:LanguageRequest["action"])=>void>(()=>{});
 const codeView=useRef<EditorView|null>(null),revealRef=useRef(reveal),revealed=useRef<number|undefined>(undefined);
 useEffect(()=>{codeView.current?.dispatch({effects:preferenceCompartment.current.reconfigure(preferenceExtensions(preferencesRef.current))});},[preferences.value.fontSize,preferences.value.tabSize,preferences.value.wrap,preferences.value.useTabs]);
 revealRef.current=reveal;
 const revealLine=()=>{const view=codeView.current,target=revealRef.current;if(!view||!target||revealed.current===target.navigation)return;const line=view.state.doc.line(Math.max(1,Math.min(target.line,view.state.doc.lines))),at=line.from+Math.min(line.length,Math.max(0,target.column-1));view.dispatch({selection:{anchor:at},effects:EditorView.scrollIntoView(at,{y:"center"})});view.focus();revealed.current=target.navigation;};
 useEffect(()=>{revealLine();},[reveal]);
 const host=useRef<HTMLDivElement>(null),flush=useRef<()=>Promise<void>>(async()=>{}),exportText=useRef(()=>{}),callbacks=useRef({onPending,onSync,onStatus,onSavedAs});
 const recovery=useRef<(draft:EditorDraft,action:"recover"|"discard"|"export")=>Promise<void>>(async()=>{});
 const [drafts,setDrafts]=useState<EditorDraft[]>([]),[cacheError,setCacheError]=useState(""),[canRecover,setCanRecover]=useState(false);
 const [error,setError]=useState(""),[people,setPeople]=useState<string[]>([]);
 const [saveState,setSaveState]=useState<EditorSaveState>({phase:"connecting",dirty:false}),stateRef=useRef(saveState);
 const [notice,setNotice]=useState(""),[saveAsOpen,setSaveAsOpen]=useState(false),[saveAsPath,setSaveAsPath]=useState(""),[saveAsError,setSaveAsError]=useState(""),[operationBusy,setOperationBusy]=useState(false);
 const [conflict,setConflict]=useState<EditorConflict|null>(null),[resolutionText,setResolutionText]=useState("");
 // Direct-link write-back state: bound local directory info for the save-location line,
 // and a disk-side conflict (external modification that didn't auto-merge) awaiting resolution.
 const [wbInfo,setWbInfo]=useState<{localPath:string;path:string}|null>(null),wbInfoRef=useRef<{localPath:string;path:string}|null>(null);
 const [wbConflict,setWbConflict]=useState<{localPath:string;path:string;conflict:{base:string;local:string|null;remote:string|null;merged:string}}|null>(null);
 const setWb=(info:{localPath:string;path:string}|null)=>{wbInfoRef.current=info;setWbInfo(info);};
 const refreshConflict=useRef<()=>Promise<void>>(async()=>{});
 const resolveConflict=useRef<(text:string)=>Promise<void>>(async()=>{});
 const wbResolve=useRef<(decision:"overwrite"|"retry")=>Promise<void>>(async()=>{});
 const candidateRef=useRef("");
 const aiCapture=useRef<()=>Promise<EditorAiBase>>(async()=>{throw new Error("编辑器尚未就绪");});
 const aiApply=useRef<(base:EditorAiBase,text:string)=>Promise<"saved"|"conflict">>(async()=>{throw new Error("编辑器尚未就绪");});
 const persistCandidate=useRef(()=>{});
 useEffect(()=>{if(conflict)persistCandidate.current();},[resolutionText,conflict]);
 const dialog=useRef<HTMLDialogElement>(null),saveNow=useRef<()=>Promise<void>>(async()=>{}),saveAs=useRef<(path:string)=>Promise<void>>(async()=>{});
 const openSaveAs=()=>{setSaveAsPath(filename.replace(/(\.[^/.]+)?$/, "-copy$1"));setSaveAsError("");setSaveAsOpen(true);};
 const openSaveAsRef=useRef(openSaveAs);openSaveAsRef.current=openSaveAs;
 useEffect(()=>{if(saveAsOpen)dialog.current?.showModal();else dialog.current?.close();},[saveAsOpen]);
 useEffect(()=>{callbacks.current={onPending,onSync,onStatus,onSavedAs};},[onPending,onSync,onStatus,onSavedAs]);
 useImperativeHandle(ref,()=>({flush:()=>flush.current()}),[]);
 useEffect(()=>{
  let alive=true,view:EditorView|undefined,inflight:Promise<void>|undefined,changed=0,acknowledged=0,writable=false;
  let lastResult:EditorSync|undefined,manualSaving=false,blocked:EditorConflict|null=null;
  let base:{text:string;revision:string;token:string}|undefined;
  let resolving=false;
  const serverText=(result:EditorSync)=>{const server=new Y.Doc();try{Y.applyUpdate(server,decode(result.document.state));return server.getText("code").toString();}finally{server.destroy();}};
  const block=(value:EditorConflict)=>{blocked=value;setConflict(value);setResolutionText(value.merged);candidateRef.current=value.merged;view?.dispatch({effects:editable.reconfigure([EditorView.editable.of(false),EditorState.readOnly.of(true)])});publish({...stateRef.current,phase:"conflict",dirty:true,revision:value.revision,message:"请查看 Diff 手动解决，或让 Agent 提供候选修复。"});callbacks.current.onPending(true);persist();};
  const publish=(next:EditorSaveState)=>{if(!alive)return;stateRef.current=next;setSaveState(next);callbacks.current.onStatus(next);};
  const readOnlyReason=(r:EditorSync)=>r.document.deleted?"文件已删除":r.canWrite?undefined:({editing:"无写入权限",frozen:"草稿已冻结",handed_off:"已交给运行工作区",archived:"草稿已归档"}[r.session.state]);
  publish({phase:"connecting",dirty:false});setNotice("");setConflict(null);
  let scope:DraftScope|undefined,ownDraft:EditorDraft|undefined,loadedDrafts=false;
  const slot=crypto.randomUUID(),recovered:{draft:EditorDraft;version:number}[]=[];
  function persist(){if(!scope)return;try{const draft={...scope,key:draftKey(scope,slot),state:encode(Y.encodeStateAsUpdate(doc)),text:text.toString(),savedAt:Date.now(),base,conflict:blocked??undefined,resolutionText:blocked?candidateRef.current:undefined};saveDraft(localStorage,draft);ownDraft=draft;stateRef.current={...stateRef.current,backup:"saved"};setCacheError("");}catch{stateRef.current={...stateRef.current,backup:"failed"};setCacheError("本机草稿保存失败（空间不足或浏览器禁止存储），请导出文本后再关闭。");}}
  persistCandidate.current=()=>persist();
  const doc=new Y.Doc(),text=doc.getText("code"),awareness=new Awareness(doc),editable=new Compartment(),undo=new Y.UndoManager(text);
  const onUpdate=(_update:Uint8Array,origin:unknown)=>{if(origin!=="server"){changed++;persist();callbacks.current.onPending(true);publish({...stateRef.current,phase:blocked?"conflict":navigator.onLine?"dirty":"offline",dirty:true,message:undefined});setNotice("");}};
  doc.on("update",onUpdate);
  exportText.current=()=>{downloadEditorText(filename.split("/").at(-1)||"draft.txt",text.toString());setNotice("已发起下载副本，请在浏览器下载列表确认；共享草稿的保存状态不变。");};
  function accept(result:EditorSync,keepLocal=false){
   if(!alive)return;const before=text.toString();if(!blocked&&!keepLocal){Y.applyUpdate(doc,decode(result.document.state),"server");if(lastResult&&before!==text.toString())stateRef.current={...stateRef.current,remoteAt:Date.now()};lastResult=result;base={text:serverText(result),revision:result.document.revision,token:result.document.baseToken};}writable=result.canWrite;setCanRecover(writable);
   scope={userId,sessionId,documentId,snapshotId:result.session.snapshot_id,manifestHash:result.session.manifest_hash};
   if(!loadedDrafts){loadedDrafts=true;try{setDrafts(readDrafts(localStorage,scope));}catch{setCacheError("浏览器禁止读取本机草稿，请保留当前页面或导出文本。");}}
   if(!view&&host.current){view=new EditorView({parent:host.current,state:EditorState.create({doc:text.toString(),extensions:[lineNumbers(),highlightActiveLine(),keymap.of([...yUndoManagerKeymap,...defaultKeymap]),syntaxHighlighting(classHighlighter),...editorTools(filename,false,supportsSemantic(filename)),...(supportsSemantic(filename)?semanticExtensions(sessionId,filename,action=>semanticCommand.current(action)):[]),yCollab(text,awareness,{undoManager:undo}),editable.of([EditorView.editable.of(writable&&!blocked),EditorState.readOnly.of(!writable||!!blocked)]),preferenceCompartment.current.of(preferenceExtensions(preferencesRef.current)),EditorView.theme({"&":{maxHeight:"460px",border:"1px solid #64748b"},".cm-scroller":{overflow:"auto"},".cm-content":{minHeight:"220px"}})]})});}
   else view?.dispatch({effects:editable.reconfigure([EditorView.editable.of(writable&&!blocked),EditorState.readOnly.of(!writable||!!blocked)])});
   codeView.current=view??null;revealLine();
   const encoder=encoding.createEncoder(),remote=result.presence.filter(p=>p.clientId!==doc.clientID);encoding.writeVarUint(encoder,remote.length);
   for(const p of remote){const color=["#2563eb","#d97706","#9333ea","#059669"][p.clientId%4];encoding.writeVarUint(encoder,p.clientId);encoding.writeVarUint(encoder,Date.now());encoding.writeVarString(encoder,JSON.stringify({user:{name:p.name,color,colorLight:`${color}33`},cursor:p.selection}));}
   applyAwarenessUpdate(awareness,encoding.toUint8Array(encoder),"server");removeAwarenessStates(awareness,[...awareness.getStates().keys()].filter(client=>client!==doc.clientID&&!remote.some(p=>p.clientId===client)),"server");
   setPeople([...new Set(result.presence.filter(p=>p.userId!==userId).map(p=>p.name))]);callbacks.current.onSync(result);
  }
  async function sync(resolution=false){
   if(inflight){await inflight;return;}if(!alive)return;if(resolving&&!resolution)return;
   inflight=(async()=>{const sent=changed,hadChanges=sent>acknowledged&&!blocked,wasUnavailable=["error","offline"].includes(stateRef.current.phase);if(hadChanges)publish({...stateRef.current,phase:"saving",dirty:true});try{
    const result=await collabApi<EditorSync>(`editors/${sessionId}/documents`,{documentId,clientId:doc.clientID,selection:awareness.getLocalState()?.cursor??null,...(hadChanges&&base?{update:encode(Y.encodeStateAsUpdate(doc)),expectedRevision:base.revision,baseText:base.text,baseToken:base.token,localText:text.toString(),resolution}:{})},"PUT",AbortSignal.timeout(15000));
    if(!alive)return;
    if(result.conflict){block(result.conflict);accept(result);setError("");return;}
    if(blocked){accept(result);publish({...stateRef.current,phase:"conflict",dirty:true,readOnlyReason:readOnlyReason(result)});return;}
    acknowledged=sent;accept(result,changed>sent);
    if(changed>acknowledged)persist();
    if(result.merged)setNotice("已检查服务器最新版本，非重叠修改已自动合并并保存。");
    if(result.writeback)handleWriteback(result.writeback,result.merged===true);
    try{if(changed===acknowledged&&ownDraft){removeDraft(localStorage,ownDraft);ownDraft=undefined;}for(let i=recovered.length-1;i>=0;i--)if(recovered[i].version<=sent){removeDraft(localStorage,recovered[i].draft);recovered.splice(i,1);}}catch{setCacheError("已同步，但本机草稿未能清理；重新打开后可丢弃重复草稿。");}
    callbacks.current.onPending(changed>acknowledged);setError("");if(wasUnavailable&&changed===acknowledged)setNotice(`同步已恢复 · ${result.canWrite?"已保存到共享草稿":`只读：${readOnlyReason(result)}`} · ${new Date().toLocaleTimeString()}`);publish(acknowledgedEditorState(stateRef.current,changed,sent,result.document.revision,readOnlyReason(result),Date.now(),false,hadChanges));
   }catch(e){if(alive){if(e instanceof CollabApiError&&(e.status===401||e.status===403||e.status===404)){setDrafts([]);setCanRecover(false);writable=false;view?.dispatch({effects:editable.reconfigure([EditorView.editable.of(false),EditorState.readOnly.of(true)])});}setError(e instanceof Error?e.message:"同步失败；保存结果尚未确认");if(e instanceof CollabApiError&&e.status===409){try{accept(await collabApi<EditorSync>(`editors/${sessionId}/documents`,{documentId,clientId:doc.clientID},"PUT"),true);}catch{}}publish({...stateRef.current,phase:navigator.onLine?"error":"offline",dirty:changed>acknowledged,readOnlyReason:e instanceof CollabApiError&&[401,403,404].includes(e.status)?"访问权限已失效":lastResult?readOnlyReason(lastResult):undefined,message:e instanceof Error?e.message:"保存结果尚未确认"});}throw e;}})();
   try{await inflight;}finally{inflight=undefined;}
  }
  recovery.current=async(draft,action)=>{try{
   // Reauthorize even export/discard; cached bytes never grant project access.
   const current=await collabApi<EditorSync>(`editors/${sessionId}/documents`,{documentId,clientId:doc.clientID},"PUT");
   if(!alive)return;accept(current);
   if(current.session.snapshot_id!==draft.snapshotId||current.session.manifest_hash!==draft.manifestHash)throw new Error("草稿来源已变化，不能应用到当前版本。");
   if(action==="export"){downloadEditorText("recovered-draft.txt",draft.text);return;}
   if(action==="discard"){removeDraft(localStorage,draft);setDrafts(readDrafts(localStorage,scope!));return;}
   if(!current.canWrite)throw new Error("当前草稿只读，请导出未同步文本。");
   // Recovered text is compared against its original acknowledged base, never silently CRDT-merged.
   const remote=serverText(current);
   const savedBase=draft.base&&typeof draft.base.text==="string"&&typeof draft.base.token==="string"&&/^[a-f0-9]{64}$/.test(draft.base.token)&&/^\d{1,18}$/.test(draft.base.revision)?draft.base:undefined;
   base=savedBase??{text:remote,revision:current.document.revision,token:current.document.baseToken};
   doc.transact(()=>{text.delete(0,text.length);text.insert(0,draft.text);},"recovery");
   recovered.push({draft,version:changed});
   if(draft.conflict||!savedBase){block(draft.conflict??{base:remote,local:draft.text,remote,merged:draft.text,revision:current.document.revision,baseToken:current.document.baseToken});if(draft.resolutionText){setResolutionText(draft.resolutionText);candidateRef.current=draft.resolutionText;}return;}
   setDrafts(old=>old.filter(d=>d.key!==draft.key));await sync();
  }catch(e){if(alive)setError(e instanceof Error?e.message:"恢复失败，原草稿仍保留。");}};
  flush.current=async()=>{if(blocked)throw new Error("存在保存冲突，请先完成 Diff 或 Agent 修复并确认保存。");await sync();if(blocked)throw new Error("存在保存冲突，请先解决后保存。");if(changed>acknowledged)await sync();if(changed>acknowledged)throw new Error("仍有未同步修改，请稍后重试。");};
  aiCapture.current=async()=>{await flush.current();if(!alive||!base||!writable)throw new Error("文件尚未就绪或只读");return {...base};};
  aiApply.current=async(from,candidate)=>{
   await flush.current();if(!alive||!writable||blocked)throw new Error("请先处理文件保存状态");
   // Flush captures all newer local edits in the shared server version. The AI's
   // signed original base then makes sync perform a three-way merge against it.
   base={...from};doc.transact(()=>{text.delete(0,text.length);text.insert(0,candidate);},"ai-candidate");
   await sync();if(blocked)return "conflict";
   if(changed>acknowledged)throw new Error("仍有未保存修改，请检查保存状态。");
   setNotice("AI 候选已检查最新版本并保存到共享草稿。");return "saved";
  };
  refreshConflict.current=async()=>{
   if(!blocked)return;
   const old=blocked,candidate=candidateRef.current;
   const current=await collabApi<EditorSync>(`editors/${sessionId}/documents`,{documentId,clientId:doc.clientID},"PUT");
   if(!alive)return;accept(current);
   block({base:old.remote,local:candidate,remote:serverText(current),merged:candidate,revision:current.document.revision,baseToken:current.document.baseToken});
   setNotice("已重新读取服务器最新版，候选已保留。请核对 Diff 后确认保存。");
  };
  resolveConflict.current=async(candidate)=>{
   if(!blocked||resolving)return;
   if(/^(<{7}|={7}|>{7}|\|{7})(?: |$)/m.test(candidate))throw new Error("请先处理全部冲突标记，再确认保存。");
   const old=blocked;resolving=true;
   try{if(inflight)await inflight;
    base={text:old.remote,revision:old.revision,token:old.baseToken};
    doc.transact(()=>{text.delete(0,text.length);text.insert(0,candidate);},"resolution");
    blocked=null;await sync(true);
    if(blocked)throw new Error("服务器版本再次变化，请核对新的 Diff 后重新确认。");
    setConflict(null);setNotice("冲突已解决，已核对最新版本并保存到共享草稿。");
   }catch(e){if(!blocked){blocked=old;setConflict(old);persist();publish({...stateRef.current,phase:"conflict",dirty:true});}throw e;}finally{resolving=false;}
  };
  // Direct-link write-back: the server mirrors each acknowledged save into the
  // bound local directory. Outcomes only ever describe the disk side; the save
  // itself already succeeded when this runs.
  function handleWriteback(wb:EditorWriteback,merged:boolean){
   const saved=merged?"已检查服务器最新版本，非重叠修改已自动合并并保存。":"已保存到共享草稿。";
   if(wb.status==="unbound"){setWb(null);setWbConflict(null);return;}
   if(wb.status==="error"){setNotice(`${saved}但本地回写失败：${wb.message}；共享草稿已保存。`);return;}
   if(wb.status==="conflict"){
    setWb({localPath:wb.localPath,path:wb.path});
    setWbConflict({localPath:wb.localPath,path:wb.path,conflict:wb.conflict});
    setNotice(`${saved}本地回写发现外部修改且无法自动合并；本机文件未被覆盖，请在下方处理。`);
    return;
   }
   setWb({localPath:wb.localPath,path:wb.path});setWbConflict(null);
   if(wb.status==="written")setNotice(`${saved}已回写到本地 ${wb.localPath}。`);
   else if(wb.status==="merged")setNotice(`${saved}本机文件有外部修改，已三方合并并回写到本地。`);
   else if(wb.status==="deleted")setNotice(`${saved}共享草稿中的删除已同步，本地文件已删除。`);
  }
  wbResolve.current=async decision=>{
   setOperationBusy(true);
   try{
    const result=await collabApi<EditorWriteback>(`editors/${sessionId}/documents/${documentId}/writeback`,{decision},"POST",AbortSignal.timeout(30000));
    if(!alive)return;
    if(result.status==="conflict"){
     setWbConflict({localPath:result.localPath,path:result.path,conflict:result.conflict});
     setNotice("本机文件仍有未解决的外部修改，未被覆盖。请在本地处理后重试，或选择覆盖。");
    }else if(result.status==="error"){setError(`本地回写失败：${result.message}`);}
    else{
     setWbConflict(null);
     if(result.status!=="unbound")setWb({localPath:result.localPath,path:result.path});
     setNotice(decision==="overwrite"?"已按保存版本覆盖本机文件。":"本地回写已完成。");
    }
   }catch(e){if(alive)setError(e instanceof Error?e.message:"本地回写操作失败");}
   finally{if(alive)setOperationBusy(false);}
  };
  saveNow.current=async()=>{if(manualSaving)return;manualSaving=true;setNotice("正在确认保存…");if(blocked){setNotice("保存已暂停：请先解决下方冲突。");manualSaving=false;return;}publish({...stateRef.current,phase:"saving"});try{await flush.current();if(!alive||!lastResult)return;if(changed>acknowledged)throw new Error("仍有未保存修改");publish(acknowledgedEditorState(stateRef.current,changed,acknowledged,lastResult.document.revision,readOnlyReason(lastResult),Date.now(),true));const bound=wbInfoRef.current;setNotice(writable?`保存成功 · ${new Date().toLocaleTimeString()} · ${filename} · ${bound?`已回写到 ${bound.localPath}`:"共享草稿"}`:`当前只读：${readOnlyReason(lastResult)}；可下载副本。`);}catch(e){if(alive)setNotice(`保存未确认：${e instanceof Error?e.message:"请重试"}`);}finally{manualSaving=false;}};
  saveAs.current=async(path)=>{await flush.current();if(!lastResult||!writable)throw new Error("当前文件只读，无法另存到共享草稿；可下载副本。");if(changed>acknowledged)throw new Error("还有未保存修改，请先保存。");const result=await collabApi<{id:string;path:string}>(`editors/${sessionId}/documents/save-as`,{documentId,path,expectedRevision:lastResult.document.revision},"POST",AbortSignal.timeout(15000));if(alive)await callbacks.current.onSavedAs(result.path);};
  const keyboard=(event:KeyboardEvent)=>{if(event.isComposing||!(event.metaKey||event.ctrlKey)||event.key.toLowerCase()!=="s")return;event.preventDefault();event.stopPropagation();if(event.repeat)return;if(event.shiftKey)openSaveAsRef.current();else void saveNow.current();};
  window.addEventListener("keydown",keyboard,true);
  const online=()=>{if(alive){setNotice("网络已恢复，正在重新同步…");void sync().catch(()=>{});}};
  const offline=()=>publish({...stateRef.current,phase:blocked?"conflict":"offline",dirty:changed>acknowledged});
  window.addEventListener("online",online);window.addEventListener("offline",offline);
  // Strict Mode tears down its first effect before this microtask; avoid
  // registering a phantom presence that consumes another window slot.
  void Promise.resolve().then(()=>sync()).catch(()=>{});const timer=setInterval(()=>{void sync().catch(()=>{});},1000);
  const beforeUnload=(event:BeforeUnloadEvent)=>{if(changed>acknowledged){event.preventDefault();event.returnValue="";}};window.addEventListener("beforeunload",beforeUnload);
  return()=>{alive=false;persistCandidate.current=()=>{};window.removeEventListener("keydown",keyboard,true);window.removeEventListener("online",online);window.removeEventListener("offline",offline);clearInterval(timer);window.removeEventListener("beforeunload",beforeUnload);codeView.current=null;view?.destroy();undo.destroy();awareness.destroy();doc.destroy();};
 },[userId,sessionId,documentId,filename]);
 async function formatCurrent(){const view=codeView.current;if(!view||view.state.readOnly||operationBusy)return;const before=view.state.doc.toString();setOperationBusy(true);try{const {text:formatted,config}=await collabApi<{text:string;config:string}>(`editors/${sessionId}/format`,{path:filename,text:before},"POST",AbortSignal.timeout(15000));if(codeView.current!==view||view.state.readOnly||view.state.doc.toString()!==before)throw new Error("格式化期间文件已变化，请重新格式化。");view.dispatch({changes:{from:0,to:view.state.doc.length,insert:formatted}});await flush.current();setNotice(`格式化完成，已检查最新版本并保存 · ${config}`);}catch(e){setError(e instanceof Error?e.message:"格式化失败");}finally{setOperationBusy(false);}}
 return <div className="wb-shared-editor"><EditorAiSlot sessionId={sessionId} path={filename}><EditorAiPanel key={`${sessionId}:${documentId}`} userId={userId} sessionId={sessionId} documentId={documentId} filename={filename} capture={()=>aiCapture.current()} apply={(base,text)=>aiApply.current(base,text)} disabled={!canRecover||!!conflict}/></EditorAiSlot><div className="wb-save-toolbar"><EditorPreferences value={preferences.value} onChange={value=>{try{preferences.save(value);}catch{setError("浏览器无法保存编辑器偏好。");}}}/><button title="将选中代码加入右侧对话" onClick={()=>{const view=codeView.current;if(!view)return;const selection=view.state.selection.main;if(selection.empty){setNotice("请先选择要讨论的代码。");return;}const text=view.state.sliceDoc(selection.from,selection.to);fileWorkspace.askAi(`关于 ${filename} 第 ${view.state.doc.lineAt(selection.from).number} 行的这段代码：\n\n${text.slice(0,6000)}\n\n请解释并给出改进建议。`);}}>选区问 AI</button><button title="查找 / 替换 · ⌘ F" onClick={()=>{if(codeView.current)openSearchPanel(codeView.current);}}>查找 / 替换</button><button title="跳到行 · Ctrl G" onClick={()=>{if(codeView.current)gotoLine(codeView.current);}}>跳转行</button><button disabled={operationBusy||!canRecover||!!conflict} onClick={()=>void formatCurrent()}>格式化</button><span role="status" className={`wb-save-badge state-${saveState.phase}`} title={editorSaveDescription(saveState)}>{editorSaveLabel(saveState)}</span><span className="wb-save-meta">{saveState.revision?`版本 ${saveState.revision}`:""}{saveState.savedAt?` · ${new Date(saveState.savedAt).toLocaleTimeString()}`:""}</span><button title="保存到共享草稿 · Ctrl / ⌘ S" disabled={operationBusy||saveState.phase==="connecting"} onClick={()=>void saveNow.current()}>保存</button><button title="另存为共享草稿中的新文件 · Ctrl / ⌘ Shift S" disabled={operationBusy||!canRecover} onClick={openSaveAs}>另存为…</button><button onClick={()=>exportText.current()}>下载副本</button></div><p className="wb-save-location">{wbInfo?`已关联本地目录 ${wbInfo.localPath} · 保存后自动回写`:"保存到共享草稿 · Git 提交需单独完成"}{saveState.readOnlyReason?` · 只读：${saveState.readOnlyReason}`:""}{saveState.dirty?saveState.backup==="saved"?" · 本机恢复副本已备份":" · 本机备份未确认":""}</p>{notice&&<p role="status" className="wb-editor-notice">{notice}</p>}{cacheError&&<p role="alert" className="collab-error">{cacheError}</p>}{drafts.length>0&&<section aria-label="未同步草稿恢复"><p>发现本账户在此文件的未同步草稿。恢复会合并到当前共享内容；只读时可导出。</p>{drafts.map(d=><div key={d.key}><span>{new Date(d.savedAt).toLocaleString()}</span> <button disabled={!canRecover} onClick={()=>void recovery.current(d,"recover")}>恢复未同步草稿</button> <button onClick={()=>void recovery.current(d,"export")}>导出未同步草稿</button> <button onClick={()=>void recovery.current(d,"discard")}>丢弃未同步草稿</button></div>)}</section>}{error&&<p role="alert" className="collab-error">{error}</p>}<p className="collab-small">{people.length?`协作在线 ${people.length} 人：${people.join("、")}`:"当前仅你在线"} · {conflict?"自动保存已暂停":"自动保存：每秒"}{saveState.remoteAt?` · 收到协作更新 ${new Date(saveState.remoteAt).toLocaleTimeString()}`:""}</p>{conflict&&<section className="wb-merge-panel" aria-label="保存冲突处理"><h3>保存冲突 · 需要你介入</h3><p>此文件自动保存已暂停。比较上次确认版本、你的修改和服务器版本 {conflict.revision}；解决后会再次校验版本。</p><div className="wb-merge-columns">{[["共同基线",conflict.base],["我的修改 Diff",conflict.local],["服务器修改 Diff",conflict.remote]].map(([label,value])=><EditorMergeDiff key={label} base={conflict.base} value={value} label={label}/>)}</div><EditorMergeDiff base={conflict.remote} value={resolutionText} label="待保存结果 Diff（相对服务器）"/><label>合并结果（可手动修改 Diff 冲突标记）<textarea aria-label="冲突合并结果" value={resolutionText} onChange={e=>{setResolutionText(e.target.value);candidateRef.current=e.target.value;setError("");}} spellCheck={false}/></label><div className="wb-merge-actions"><button onClick={()=>{downloadEditorText(`${filename.split("/").at(-1)||"file"}-conflict.json`,JSON.stringify({path:filename,base:conflict.base,local:conflict.local,remote:conflict.remote,revision:conflict.revision,candidate:resolutionText},null,2));setNotice("已发起下载三方内容与候选，请在浏览器下载列表确认。");}}>下载三方与候选</button><button disabled={operationBusy} onClick={()=>{setOperationBusy(true);void refreshConflict.current().catch(e=>setError(e.message)).finally(()=>setOperationBusy(false));}}>重新读取最新版（保留候选）</button><button onClick={()=>{setResolutionText(conflict.local);candidateRef.current=conflict.local;}}>采用我的版本作为候选</button><button onClick={()=>{setResolutionText(conflict.remote);candidateRef.current=conflict.remote;}}>采用服务器版本作为候选</button><button disabled={operationBusy||!canRecover} onClick={()=>{setOperationBusy(true);void resolveConflict.current(resolutionText).catch(e=>setError(e.message)).finally(()=>setOperationBusy(false));}}>确认解决并保存</button></div><EditorConflictAgent key={conflict.revision} userId={userId} sessionId={sessionId} documentId={documentId} conflict={conflict} onCandidate={value=>{setError("");setResolutionText(value);candidateRef.current=value;setNotice("Agent 候选已载入，请查看 Diff 并确认解决后保存。");}}/></section>}{wbConflict&&<section className="wb-merge-panel" aria-label="本地回写冲突处理"><h3>本地回写冲突 · 本机文件未被覆盖</h3><p>保存已进入共享草稿，但 {wbConflict.localPath} 下的 {wbConflict.path} 在本机被外部修改且无法自动合并。本地文件保持原样，你可以先在本地处理外部修改再重试，或直接用保存版本覆盖。</p><div className="wb-merge-columns">{[["上次回写版本",wbConflict.conflict.base],["保存版本（共享草稿）",wbConflict.conflict.local??"（已在共享草稿中删除）"],["本机当前版本",wbConflict.conflict.remote??"（本机已删除）"]].map(([label,value])=><EditorMergeDiff key={label} base={wbConflict.conflict.base} value={value} label={label}/>)}</div><div className="wb-merge-actions"><button disabled={operationBusy} onClick={()=>void wbResolve.current("retry")}>重新尝试回写</button><button disabled={operationBusy||!canRecover} onClick={()=>{if(window.confirm("将用共享草稿的保存版本覆盖本机文件，外部修改会被替换，确定继续吗？"))void wbResolve.current("overwrite");}}>采用保存版本覆盖本机</button><button onClick={()=>{downloadEditorText(`${filename.split("/").at(-1)||"file"}-writeback-conflict.json`,JSON.stringify({path:wbConflict.path,localPath:wbConflict.localPath,base:wbConflict.conflict.base,local:wbConflict.conflict.local,remote:wbConflict.conflict.remote},null,2));setNotice("已发起下载回写三方内容，请在浏览器下载列表确认。");}}>下载三方内容</button></div></section>}{supportsSemantic(filename)&&<EditorLanguagePanel workspaceVersion={workspaceVersion} sessionId={sessionId} filename={filename} viewRef={codeView} commandRef={semanticCommand} flush={()=>flush.current()} onNavigate={onNavigate}/>}<div ref={host} aria-label="共享代码编辑器" style={conflict?{display:"none"}:undefined} /><dialog ref={dialog} className="wb-save-dialog" onCancel={e=>{if(operationBusy)e.preventDefault();else setSaveAsOpen(false);}} aria-label="另存为新文件"><form onSubmit={e=>{e.preventDefault();if(operationBusy)return;setOperationBusy(true);setSaveAsError("");void saveAs.current(saveAsPath.trim()).then(()=>setSaveAsOpen(false)).catch(e=>setSaveAsError(`另存为未确认：${e.message}。若连接中断，请先在文件树核对目标文件。`)).finally(()=>setOperationBusy(false));}}><h2>另存为新文件</h2><p>位置：当前任务的共享草稿。原文件保留，已有路径不会被覆盖。</p><label>新文件路径<input autoFocus aria-label="另存为文件路径" value={saveAsPath} onChange={e=>setSaveAsPath(e.target.value)} required maxLength={1024} disabled={operationBusy}/></label>{saveAsError&&<p role="alert" className="collab-error">{saveAsError}</p>}<div><button type="button" disabled={operationBusy} onClick={()=>setSaveAsOpen(false)}>取消</button><button type="submit" disabled={operationBusy||!saveAsPath.trim()}>{operationBusy?"正在另存为…":"另存为并打开"}</button></div></form></dialog></div>;
});
