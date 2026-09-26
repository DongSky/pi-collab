"use client";
import { useCallback,useEffect,useRef,useState } from "react";
import { emptyDiscussionDraft,readDiscussionDraft,writeDiscussionDraft,type DiscussionDraft } from "@/lib/collab/discussion-draft";
export function useDiscussionDraft(key:string,authorized:boolean,onRestore:(draft:DiscussionDraft)=>void){
 const [draft,setDraft]=useState(emptyDiscussionDraft),[loaded,setLoaded]=useState(""),[error,setError]=useState("");
 const current=useRef({key,draft}),restore=useRef(onRestore);restore.current=onRestore;
 useEffect(()=>{
  if(!authorized||loaded===key)return;
  try{const value=readDiscussionDraft(sessionStorage,key);current.current={key,draft:value};setDraft(value);setLoaded(key);setError("");restore.current(value);}
  catch{setError("无法恢复本窗口的讨论草稿或原请求编号，请先核对已有讨论；尚未发送任何请求。");}
 },[authorized,key,loaded]);
 const change=useCallback((update:(old:DiscussionDraft)=>DiscussionDraft)=>{
  if(current.current.key!==key||loaded!==key)return false;
  const value=update(current.current.draft);current.current={key,draft:value};setDraft(value);
  try{writeDiscussionDraft(sessionStorage,key,value);setError("");return true;}
  catch(e){setError(e instanceof DOMException?"无法保存本窗口草稿，请检查浏览器会话存储和剩余空间后再发送。":e instanceof Error?e.message:"无法保存本窗口草稿，请允许会话存储后再发送。");return false;}
 },[key,loaded]);
 return {draft,change,ready:authorized&&loaded===key,error};
}
