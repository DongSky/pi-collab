import path from "node:path";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { editorPayload, type EditorVersion } from "../editor-schema";
import { loadSnapshot, safeSnapshotPath, snapshotExcludedPath, snapshotHasSecret } from "./snapshots";
const hash=(b:Buffer|string)=>createHash("sha256").update(b).digest("hex");
/** Only called in a new restored checkout before any process is launched. */
export async function applyEditorVersion(root:string,checkout:string,version:EditorVersion,restored:{id:string;manifestHash:string}) {
 const payload=editorPayload.parse(version.payload);
 if(payload.snapshotId!==restored.id||payload.manifestHash!==restored.manifestHash)throw new Error("editor_source_mismatch");
 const saved=await loadSnapshot(root,restored.id,restored.manifestHash),base=await realpath(checkout),seen=new Set<string>();
 for(const file of payload.files){
  if(!safeSnapshotPath(file.path)||snapshotExcludedPath(file.path)||seen.has(file.path))throw new Error("editor_unsafe_path");seen.add(file.path);
  const entry=saved.manifest.worktree.find(f=>f.path===file.path);
  if((entry?.hash??null)!==file.baseHash)throw new Error("editor_source_changed");
  if(file.text!==null){const bytes=Buffer.from(file.text);if(bytes.length>262144||bytes.includes(0)||!isUtf8(bytes)||snapshotHasSecret(bytes))throw new Error("editor_content_unavailable");}
  let current=base;
  for(const part of file.path.split("/").slice(0,-1)){current=path.join(current,part);const st=await lstat(current).catch(e=>{if(e.code!=="ENOENT")throw e;return null;});if(st&&(!st.isDirectory()||st.isSymbolicLink()))throw new Error("editor_unsafe_path");}
  const target=path.join(base,file.path),st=await lstat(target).catch(e=>{if(e.code!=="ENOENT")throw e;return null;});
  if(file.baseHash===null){if(st)throw new Error("editor_source_changed");}
  else {if(!st?.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>262144)throw new Error("editor_unsafe_path");const handle=await open(target,constants.O_RDONLY|constants.O_NOFOLLOW);try{if(hash(await handle.readFile())!==file.baseHash)throw new Error("editor_source_changed");}finally{await handle.close();}}
 }
 // Preflight all paths before modifying this disposable checkout. Failed writes never alter the source snapshot.
 for(const file of payload.files){
  const target=path.join(base,file.path);if(file.text===null){if(file.baseHash!==null)await unlink(target);continue;}
  await mkdir(path.dirname(target),{recursive:true});const handle=await open(target,constants.O_WRONLY|constants.O_NOFOLLOW|(file.baseHash===null?constants.O_CREAT|constants.O_EXCL:0),0o644);
  try{const bytes=Buffer.from(file.text);await handle.writeFile(bytes);await handle.truncate(bytes.length);await handle.sync();}finally{await handle.close();}
 }
 return hash(JSON.stringify(payload));
}
