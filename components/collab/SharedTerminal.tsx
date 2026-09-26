"use client";
import {useEffect,useRef,useState} from "react";
import type {Terminal} from "@xterm/xterm";
import {collabApi} from "./api";
import type {ControlState} from "./RunControl";
type Batch={sequence:string;payload:{events:{type:string;text?:string;cols?:number;rows?:number}[]}};
type Command={type:"input";data:string}|{type:"resize";cols:number;rows:number};
export function SharedTerminal({runId,userId,status,control,batches,truncated}:{runId:string;userId:string;status:string;control:ControlState;batches:Batch[];truncated:boolean}){
 const host=useRef<HTMLDivElement>(null),terminal=useRef<Terminal|null>(null),last=useRef(BigInt(0)),latest=useRef({control,status}),buffer=useRef(""),sending=useRef(false),pending=useRef<{expectedVersion:string;idempotencyKey:string;command:Command}|null>(null),retry=useRef<()=>Promise<void>>(async()=>{}),liveInput=useRef(false);
 const [ready,setReady]=useState(false),[direct,setDirect]=useState(false),[command,setCommand]=useState(""),[error,setError]=useState(""),[hasPending,setHasPending]=useState(false),[fontSize,setFontSize]=useState(13),[height,setHeight]=useState(320),[cols,setCols]=useState(80),[rows,setRows]=useState(24);
 const allowed=control.controllerId===userId&&control.valid&&control.instructionsOpen&&["running","waiting_input"].includes(status);
 useEffect(()=>{latest.current={control,status};liveInput.current=direct&&allowed;if(terminal.current)terminal.current.options.disableStdin=!direct||!allowed;},[control,status,direct,allowed]);
 useEffect(()=>{try{const saved=JSON.parse(localStorage.getItem(`pi-collab:terminal-view:${userId}`)??"null");if(saved){if([11,13,16,18].includes(saved.fontSize))setFontSize(saved.fontSize);if([240,320,480,640].includes(saved.height))setHeight(saved.height);}}catch{}},[userId]);
 useEffect(()=>{localStorage.setItem(`pi-collab:terminal-view:${userId}`,JSON.stringify({fontSize,height}));if(terminal.current)terminal.current.options.fontSize=fontSize;},[fontSize,height,userId]);
 async function send(value:Command){
  if(sending.current||pending.current)return;pending.current={expectedVersion:latest.current.control.version,idempotencyKey:crypto.randomUUID(),command:value};setHasPending(true);await retry.current();
 }
 useEffect(()=>{
  let disposed=false;retry.current=async()=>{
   const request=pending.current;if(!request||sending.current)return;sending.current=true;
   try{await collabApi(`runs/${runId}/terminal`,request);if(disposed)return;pending.current=null;setHasPending(false);setError("");}
   catch(e){if(!disposed){setError(e instanceof Error?e.message:"投递未确认，请重试原输入。输入缓冲仍保留。");liveInput.current=false;setDirect(false);if(terminal.current)terminal.current.options.disableStdin=true;}}
   finally{sending.current=false;}
  };
  const tick=setInterval(()=>{if(!buffer.current||pending.current||sending.current)return;const data=buffer.current.slice(0,8192);buffer.current=buffer.current.slice(8192);void send({type:"input",data});},150);
  void (async()=>{
   const {Terminal}=await import("@xterm/xterm");if(disposed||!host.current)return;
   const t=new Terminal({cols:80,rows:24,fontSize:13,scrollback:8000,disableStdin:true,screenReaderMode:true,theme:{background:"#111318",foreground:"#d7dce5",cursor:"#60a5fa"}});terminal.current=t;t.open(host.current);
   // Remote output cannot write the viewer's clipboard.
   t.parser.registerOscHandler(52,()=>true);
   // Keep type-ahead while the previous packet awaits acknowledgement.
   // The timer serializes delivery; dropping here loses ordinary keystrokes.
   t.onData(data=>{if(liveInput.current){if(buffer.current.length+data.length<=32768)buffer.current+=data;else{setError("输入缓冲已满，请等待或保存命令后重试。");setDirect(false);}}});setReady(true);
  })().catch(e=>{if(!disposed)setError(e.message);});
  return()=>{disposed=true;clearInterval(tick);terminal.current?.dispose();terminal.current=null;};
 // This effect owns one terminal and its bounded input queue for the selected run.
 },[runId]);
 useEffect(()=>{if(!ready||!terminal.current)return;for(const batch of batches){if(BigInt(batch.sequence)<=last.current)continue;for(const event of batch.payload.events){if(event.type==="terminal_output"&&event.text)terminal.current.write(event.text);if(event.type==="terminal_resize"&&event.cols&&event.rows){terminal.current.resize(event.cols,event.rows);setCols(event.cols);setRows(event.rows);}}last.current=BigInt(batch.sequence);}},[batches,ready]);
 useEffect(()=>{if(!allowed){buffer.current="";setDirect(false);}},[allowed,control.version]);
 return <section className="collab-snapshots" aria-label="共享人工终端"><h3>共享人工终端</h3><p role="status">{allowed?"你拥有输入权":"旁观模式"} · 当前控制者：{control.controllerName}</p><p className="collab-small collab-muted">所有项目成员共享输出。输入与执行结果会保存在项目中。停止并保存快照后，可交给 AI 接续。</p>{truncated&&<p className="collab-small">当前重放最近 100 批输出；较早的屏幕内容可能不完整。</p>}
 {error&&<p className="collab-error" role="alert">{error}</p>}
 <div className="collab-form compact"><label>本窗口字号<select aria-label="本窗口字号" value={fontSize} onChange={e=>setFontSize(Number(e.target.value))}>{[11,13,16,18].map(v=><option key={v} value={v}>{v}px</option>)}</select></label><label>本窗口高度<select aria-label="本窗口高度" value={height} onChange={e=>setHeight(Number(e.target.value))}>{[240,320,480,640].map(v=><option key={v} value={v}>{v}px</option>)}</select></label></div>
 <div style={{height,overflow:"auto",maxWidth:"100%",background:"#111318"}}><div ref={host} aria-label="共享终端屏幕" style={{minWidth:200}}/></div>
 {allowed&&<div className="collab-form compact"><label><input type="checkbox" checked={direct} disabled={hasPending} onChange={e=>setDirect(e.target.checked)}/>直接键盘输入（点击终端后输入）</label><label>终端命令<textarea aria-label="终端命令" value={command} onChange={e=>setCommand(e.target.value)} maxLength={8191}/></label><div><button className="collab-button" disabled={hasPending||!command} onClick={()=>{void send({type:"input",data:command+"\r"});setCommand("");}}>发送终端命令</button> <button className="collab-button" disabled={hasPending} onClick={()=>void send({type:"input",data:"\u0003"})}>中断 Ctrl+C</button></div><div><label>共享列数<input aria-label="共享列数" type="number" min={20} max={240} value={cols} onChange={e=>setCols(Number(e.target.value))}/></label><label>共享行数<input aria-label="共享行数" type="number" min={5} max={100} value={rows} onChange={e=>setRows(Number(e.target.value))}/></label><button className="collab-text-button" disabled={hasPending} onClick={()=>{void send({type:"resize",cols,rows});}}>应用终端尺寸</button></div></div>}
 {hasPending&&!error&&<p role="status">正在确认输入；后续按键会排队发送。</p>}
 {hasPending&&error&&<div><p>原输入请求保留；未知结果不会自动再次执行。</p><button className="collab-button" onClick={()=>void retry.current()}>重试原终端输入</button><button className="collab-text-button" onClick={()=>{pending.current=null;buffer.current="";setHasPending(false);setError("");}}>丢弃本地待发送输入</button></div>}
 </section>;
}
