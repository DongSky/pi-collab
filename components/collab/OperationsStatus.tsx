"use client";
import { useEffect,useState } from "react";
import { collabApi } from "./api";
export function OperationsStatus(){
 const [draining,setDraining]=useState(false);
 useEffect(()=>{let active=true;const load=()=>void collabApi<{draining:boolean}>("operations").then(result=>{if(active)setDraining(result.draining);}).catch(()=>{});load();const timer=setInterval(load,10000);return()=>{active=false;clearInterval(timer);};},[]);
 return draining?<p className="collab-error" role="status">实例正在排空升级，暂不接收新任务和修改。已有工作继续执行；你可以查看进度或停止运行。</p>:null;
}
