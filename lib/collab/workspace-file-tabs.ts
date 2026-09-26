export type WorkspaceFile = { id:string; projectId:string; taskId?:string; kind:"browse"|"shared"; source:string; path:string; line?:number; column?:number; navigation?:number };
export function workspaceFile(input:Omit<WorkspaceFile,"id">):WorkspaceFile {
 return {...input,id:JSON.stringify([input.projectId,input.taskId??"",input.kind,input.source,input.path])};
}
/** Restore navigation metadata only, after the project and task catalogue have been authorized. */
export function restoreWorkspaceFiles(raw:string|null,projectId:string,taskIds:string[]):{tabs:WorkspaceFile[];active:WorkspaceFile|null} {
 const empty={tabs:[],active:null};
 try{
  const value=JSON.parse(raw??"null");if(!value||!Array.isArray(value.tabs))return empty;
  const uuid="[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}",tabs:WorkspaceFile[]=[];
  for(const input of value.tabs.slice(0,64)){
   if(!input||input.projectId!==projectId||(input.taskId!==undefined&&!taskIds.includes(input.taskId))||!["browse","shared"].includes(input.kind))continue;
   if(typeof input.path!=="string"||!input.path||input.path.length>1024||input.path.startsWith("/")||input.path.split("/").some((part:string)=>!part||part===".."||part===".")||/[\\\x00-\x1f\x7f]/.test(input.path))continue;
   if(typeof input.source!=="string"||!(new RegExp(input.kind==="shared"?`^${uuid}$`:`^(repo|snapshot):${uuid}$`)).test(input.source)||(input.kind==="shared"&&!input.taskId))continue;
   const tab=workspaceFile({projectId,taskId:input.taskId,kind:input.kind,source:input.source,path:input.path});
   if(!tabs.some(t=>t.id===tab.id))tabs.push(tab);
  }
  return {tabs,active:tabs.find(t=>t.id===value.active)??null};
 }catch{return empty;}
}
