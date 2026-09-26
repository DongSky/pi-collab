import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
const exec = promisify(execFile);
/** Binds the client's last acknowledged text to the exact server document/version. */
export function editorBaseToken(documentId:string,revision:string,text:string) {
 const secret=process.env.BETTER_AUTH_SECRET;
 if(!secret)throw new Error("BETTER_AUTH_SECRET is required");
 return createHmac("sha256",secret).update(JSON.stringify(["editor-save-v1",documentId,revision,createHash("sha256").update(text).digest("hex")])).digest("hex");
}
export function validEditorBase(documentId:string,revision:string,text:string,token:string) {
 const expected=Buffer.from(editorBaseToken(documentId,revision,text));const actual=Buffer.from(token);
 return actual.length===expected.length&&timingSafeEqual(actual,expected);
}
export async function mergeEditorText(base:string,local:string,remote:string):Promise<{text:string;conflicted:boolean}> {
 if(local===remote||base===remote)return {text:local,conflicted:false};
 if(base===local)return {text:remote,conflicted:false};
 const directory=await mkdtemp(path.join(tmpdir(),"pi-collab-merge-"));
 try {
  await Promise.all([writeFile(path.join(directory,"base"),base,{mode:0o600}),writeFile(path.join(directory,"local"),local,{mode:0o600}),writeFile(path.join(directory,"remote"),remote,{mode:0o600})]);
  try {const result=await exec("git",["merge-file","--stdout","--diff3","-L","LOCAL","-L","BASE","-L","SERVER","local","base","remote"],{cwd:directory,encoding:"utf8",timeout:10000,maxBuffer:4*1024*1024});return {text:result.stdout,conflicted:false};}
  catch(error){const e=error as {code?:number;stdout?:string;killed?:boolean};if(!e.killed&&typeof e.code==="number"&&e.code>=1&&e.code<=127&&typeof e.stdout==="string"&&e.stdout.includes("<<<<<<< LOCAL"))return {text:e.stdout,conflicted:true};throw error;}
 } finally {await rm(directory,{recursive:true,force:true});}
}
