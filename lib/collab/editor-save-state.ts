export type EditorSaveState={phase:"connecting"|"dirty"|"saving"|"saved"|"error"|"offline"|"readonly"|"conflict";dirty:boolean;revision?:string;savedAt?:number;remoteAt?:number;readOnlyReason?:string;backup?:"saved"|"failed";message?:string};
export function acknowledgedEditorState(previous:EditorSaveState,changed:number,sent:number,revision:string,readOnlyReason:string|undefined,now:number,confirm=false,wrote=false):EditorSaveState {
 const dirty=changed>sent;
 return {...previous,phase:dirty?"dirty":readOnlyReason?"readonly":"saved",dirty,revision,readOnlyReason,message:undefined,savedAt:confirm||!previous.savedAt||wrote?now:previous.savedAt};
}
export function editorSaveLabel(state:EditorSaveState):string {
 if(state.phase==="conflict")return "保存冲突 · 待解决";
 if(state.phase==="saving")return "保存中…";
 if(state.phase==="offline")return state.dirty?"离线 · 未保存":"连接中断";
 if(state.phase==="error")return state.dirty?"保存失败 · 未保存":"同步失败";
 if(state.dirty)return state.readOnlyReason?"只读 · 有未保存修改":"未保存";
 if(state.phase==="connecting")return "连接中…";
 if(state.readOnlyReason)return `只读 · ${state.readOnlyReason}`;
 return "已保存";
}
export function editorSaveDescription(state:EditorSaveState):string {
 return [editorSaveLabel(state),state.savedAt?`上次保存 ${new Date(state.savedAt).toLocaleTimeString()}`:"",state.revision?`服务器文件版本 ${state.revision}`:"",state.dirty?(state.backup==="saved"?"未保存修改已备份到本机":state.backup==="failed"?"本机备份失败，请下载副本":"修改尚未确认保存"):"",state.readOnlyReason,state.message,"保存位置：共享草稿；Git 提交需在 Git 流程中完成"].filter(Boolean).join(" · ");
}
