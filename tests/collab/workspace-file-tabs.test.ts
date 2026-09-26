import test from "node:test";
import assert from "node:assert/strict";
import { workspaceFile,restoreWorkspaceFiles } from "../../lib/collab/workspace-file-tabs";
const projectId="project",taskId="task-a",repo="00000000-0000-4000-8000-000000000001",room="00000000-0000-4000-8000-000000000002";
const file=workspaceFile({projectId,taskId,kind:"browse",source:`repo:${repo}`,path:"src/index.ts"});
test("same path in different tasks, repositories and shared rooms remains separate",()=>{
 const tabs=[file,workspaceFile({...file,taskId:"task-b"}),workspaceFile({...file,source:`snapshot:${repo}`}),workspaceFile({...file,kind:"shared",source:room})];
 assert.equal(new Set(tabs.map(t=>t.id)).size,4);
 const restored=restoreWorkspaceFiles(JSON.stringify({tabs,active:tabs[3].id}),projectId,[taskId,"task-b"]);
 assert.equal(restored.tabs.length,4);assert.equal(restored.active?.kind,"shared");
});
test("refresh restores metadata only and refuses removed tasks and cross-project tabs",()=>{
 const tabs=[{...file,text:"must not restore document bytes"},file,workspaceFile({...file,taskId:"removed"}),workspaceFile({...file,projectId:"other"})];
 const restored=restoreWorkspaceFiles(JSON.stringify({tabs,active:file.id}),projectId,[taskId]);
 assert.deepEqual(restored,{tabs:[file],active:file});assert.ok(!("text" in restored.tabs[0]));
});
test("invalid cached paths, sources and malformed storage cannot activate a file",()=>{
 for(const changed of [{path:"../private"},{path:"/etc/passwd"},{path:"a\u0000b"},{source:"HEAD"},{source:`repo:${repo}`,kind:"shared"},{taskId:undefined,kind:"shared",source:room}]){
  assert.deepEqual(restoreWorkspaceFiles(JSON.stringify({tabs:[{...file,...changed}],active:file.id}),projectId,[taskId]),{tabs:[],active:null});
 }
 assert.deepEqual(restoreWorkspaceFiles("{broken",projectId,[taskId]),{tabs:[],active:null});
});
