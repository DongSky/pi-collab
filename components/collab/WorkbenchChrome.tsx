"use client";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useTheme } from "@/hooks/useTheme";

export type WorkbenchIconName = "tasks" | "map" | "code" | "git" | "team" | "history" | "settings" | "search" | "panel" | "terminal" | "close" | "check";
const paths: Record<WorkbenchIconName, ReactNode> = {
 tasks:<><rect x="5" y="3" width="14" height="18" rx="2"/><path d="m8 8 1 1 2-2m2 1h3M8 13h8M8 17h5"/></>,
 map:<><rect x="9" y="2" width="6" height="5" rx="1"/><rect x="2" y="17" width="6" height="5" rx="1"/><rect x="16" y="17" width="6" height="5" rx="1"/><path d="M12 7v5H5v5m7-5h7v5"/></>,
 code:<><path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-14-2 16"/></>,
 git:<><circle cx="6" cy="5" r="3"/><circle cx="6" cy="19" r="3"/><circle cx="18" cy="6" r="3"/><path d="M6 8v8m12-7c0 6-12 0-12 7"/></>,
 team:<><circle cx="9" cy="7" r="4"/><path d="M2 21v-3a7 7 0 0 1 14 0v3m0-18a4 4 0 0 1 0 8m3 4a6 6 0 0 1 3 6"/></>,
 history:<><path d="M3 11a9 9 0 1 1 2 7M3 4v7h7m2-4v6l4 2"/></>,
 settings:<><circle cx="12" cy="12" r="3"/><path d="m9 3 1-2h4l1 2 3 2 2 1 2 4-1 2 1 2-2 4-2 1-3 2-1 2h-4l-1-2-3-2-2-1-2-4 1-2-1-2 2-4 2-1Z"/></>,
 search:<><circle cx="10" cy="10" r="7"/><path d="m15 15 6 6"/></>,
 panel:<><rect x="2" y="3" width="20" height="18" rx="2"/><path d="M15 3v18"/></>,
 terminal:<><path d="m4 7 5 5-5 5m8 0h8"/></>,
 close:<path d="m6 6 12 12M6 18 18 6"/>,
 check:<path d="m4 12 5 5L20 6"/>,
};
export function WorkbenchIcon({ name }: { name: WorkbenchIconName }) { return <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>; }

export function ThemeControl() {
 const {preference,setThemePreference}=useTheme();
 return <label className="wb-theme">外观<select aria-label="工作台主题" value={["dark","light","auto"].includes(preference)?preference:"dark"} onChange={e=>setThemePreference(e.target.value as "dark"|"light"|"auto")}><option value="dark">深色</option><option value="light">浅色</option><option value="auto">跟随系统</option></select></label>;
}

export function usePanelSize(key:string,initial:number,min:number,max:number) {
 const [value,setValue]=useState(initial);
 useEffect(()=>{try{const saved=Number(localStorage.getItem(key));if(saved>=min&&saved<=max)setValue(saved);}catch{}},[key,min,max]);
 const change=(next:number)=>{const bounded=Math.max(min,Math.min(max,next));setValue(bounded);try{localStorage.setItem(key,String(bounded));}catch{}};
 return {value,change,style:{"--panel-size":`${value}px`} as CSSProperties};
}
export function PanelResize({label,value,onChange,min,max,direction="right"}:{label:string;value:number;onChange:(value:number)=>void;min:number;max:number;direction?:"right"|"left"}) {
 return <div className="wb-resize" role="separator" aria-label={label} aria-orientation="vertical" aria-valuemin={min} aria-valuemax={max} aria-valuenow={value} tabIndex={0}
 onKeyDown={e=>{if(e.key==="ArrowLeft"||e.key==="ArrowRight"){e.preventDefault();onChange(value+(e.key==="ArrowRight"?20:-20)*(direction==="left"?-1:1));}}}
 onPointerDown={e=>{if(e.button!==0)return;const element=e.currentTarget,origin=e.clientX,start=value;element.setPointerCapture(e.pointerId);const move=(event:PointerEvent)=>onChange(start+(event.clientX-origin)*(direction==="left"?-1:1));const end=()=>{element.removeEventListener("pointermove",move);element.removeEventListener("pointerup",end);element.removeEventListener("pointercancel",end);};element.addEventListener("pointermove",move);element.addEventListener("pointerup",end);element.addEventListener("pointercancel",end);}} />;
}
export type WorkbenchCommand={id:string;label:string;detail:string;run:()=>void};
export function CommandPalette({commands,onClose,label="搜索项目、任务和命令"}:{commands:WorkbenchCommand[];onClose:()=>void;label?:string}) {
 const dialog=useRef<HTMLDialogElement>(null),[query,setQuery]=useState(""),[index,setIndex]=useState(0);
 const visible=commands.filter(c=>`${c.label} ${c.detail}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())).slice(0,40);
 useEffect(()=>{dialog.current?.querySelector<HTMLElement>(".wb-command-results>.selected")?.scrollIntoView({block:"nearest"});},[index,query]);
 useEffect(()=>{const node=dialog.current,previous=document.activeElement as HTMLElement|null;node?.showModal();return()=>{node?.close();previous?.focus();};},[]);
 const choose=(command:WorkbenchCommand)=>{onClose();command.run();};
 return <dialog className="wb-command-dialog" ref={dialog} aria-label={label} onCancel={e=>{e.preventDefault();onClose();}} onClick={e=>{if(e.target===e.currentTarget)onClose();}}><div className="wb-command-content">
 <div className="wb-command-input"><WorkbenchIcon name="search"/><input autoFocus aria-label={label} placeholder={`${label}…`} value={query} onChange={e=>{setQuery(e.target.value);setIndex(0);}} onKeyDown={e=>{if(e.nativeEvent.isComposing)return;if(e.key==="ArrowDown"||e.key==="ArrowUp"){e.preventDefault();setIndex(old=>Math.max(0,Math.min(visible.length-1,old+(e.key==="ArrowDown"?1:-1))));}else if(e.key==="Enter"&&visible[index]){e.preventDefault();choose(visible[index]);}}}/><button onClick={onClose} aria-label="关闭命令面板">Esc</button></div>
 <div className="wb-command-results">{visible.length?visible.map((command,i)=><button key={command.id} className={i===index?"selected":""} onFocus={()=>setIndex(i)} onClick={()=>choose(command)}><span>{command.label}</span><small>{command.detail}</small></button>):<p>没有找到匹配结果。</p>}</div><footer>↑ ↓ 选择 · Enter 打开 · Esc 关闭</footer>
 </div></dialog>;
}
