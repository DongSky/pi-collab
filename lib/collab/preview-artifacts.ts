import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {mkdir,open,lstat,rm} from 'node:fs/promises';
import path from 'node:path';
import {z} from 'zod';
import {loadSnapshot} from './runtime/snapshots';
import {safeSnapshotPath} from './snapshot-paths';
export const previewPath=z.string().max(500).refine(safeSnapshotPath);
const hash=(v:Buffer|string)=>createHash('sha256').update(v).digest('hex');
const asset=z.object({path:previewPath,hash:z.string().regex(/^[a-f0-9]{64}$/),size:z.number().int().min(0).max(2*1024*1024)}).strict();
const manifest=z.object({version:z.literal(1),id:z.uuid(),snapshotId:z.uuid(),snapshotHash:z.string().regex(/^[a-f0-9]{64}$/),entry:previewPath,files:z.array(asset).min(1).max(200)}).strict();
export const previewDirectory=(root:string,id:string)=>path.join(root,'checkpoint-previews',z.uuid().parse(id));
export const mime:Record<string,string>={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.json':'application/json','.txt':'text/plain; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.ico':'image/x-icon','.woff':'font/woff','.woff2':'font/woff2'};
async function save(file:string,bytes:Buffer|string){const f=await open(file,'wx',0o600);try{await f.writeFile(bytes);await f.sync();}finally{await f.close();}}
async function read(file:string,limit:number){const f=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);try{const stat=await f.stat();if(!stat.isFile()||stat.nlink!==1||stat.size>limit)throw new Error('preview_artifact_invalid');return await f.readFile();}finally{await f.close();}}
export async function preparePreview(root:string,id:string,snapshotId:string,snapshotHash:string,folder:string,entry:string){
 previewPath.parse(folder);previewPath.parse(entry);if(path.posix.extname(entry).toLowerCase()!=='.html')throw new Error('invalid_preview');
 const loaded=await loadSnapshot(root,snapshotId,snapshotHash),files=loaded.manifest.worktree.filter(f=>f.path.startsWith(`${folder}/`)).map(f=>({...f,path:f.path.slice(folder.length+1)}));
 if(!files.some(f=>f.path===entry)||files.length>200||files.length===0||files.some(f=>!mime[path.posix.extname(f.path).toLowerCase()]))throw new Error('preview_static_files_required');
 const total=files.reduce((sum,f)=>sum+f.size,0);if(total>8*1024*1024)throw new Error('preview_limit');
 const dir=previewDirectory(root,id);await mkdir(path.dirname(dir),{recursive:true,mode:0o700});await mkdir(dir,{mode:0o700});await mkdir(path.join(dir,'blobs'),{mode:0o700});
 const seen=new Set<string>();for(const f of files){if(!seen.has(f.hash)){await save(path.join(dir,'blobs',f.hash),loaded.blobs.get(f.hash)!);seen.add(f.hash);}}
 const bytes=JSON.stringify(manifest.parse({version:1,id,snapshotId,snapshotHash,entry,files:files.map(f=>({path:f.path,hash:f.hash,size:f.size}))}));await save(path.join(dir,'manifest.json'),bytes);return{hash:hash(bytes),files:files.length,bytes:total};
}
export async function previewAsset(root:string,id:string,expectedHash:string,file:string){
 previewPath.parse(file);const dir=previewDirectory(root,id);for(const p of [dir,path.join(dir,'blobs')]){const info=await lstat(p);if(info.isSymbolicLink()||!info.isDirectory())throw new Error('preview_artifact_invalid');}
 const bytes=await read(path.join(dir,'manifest.json'),128*1024);if(hash(bytes)!==expectedHash)throw new Error('preview_artifact_invalid');const m=manifest.parse(JSON.parse(bytes.toString()));if(m.id!==id)throw new Error('preview_artifact_invalid');const found=m.files.find(f=>f.path===file);if(!found)return null;
 const body=await read(path.join(dir,'blobs',found.hash),2*1024*1024);if(hash(body)!==found.hash||body.length!==found.size)throw new Error('preview_artifact_invalid');return{body,type:mime[path.posix.extname(file).toLowerCase()]??'application/octet-stream'};
}
export function removePreview(root:string,id:string){return rm(previewDirectory(root,id),{recursive:true,force:true});}
