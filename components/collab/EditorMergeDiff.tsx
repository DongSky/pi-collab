"use client";
import { useMemo } from "react";
import { diffLines } from "diff";
export function EditorMergeDiff({base,value,label}:{base:string;value:string;label:string}){
 const changes=useMemo(()=>diffLines(base,value,{timeout:100,maxEditLength:2000}),[base,value]);
 return <details open><summary>{label}</summary><pre aria-label={label}>{changes?changes.map((part,i)=><span key={i} className={part.added?"merge-added":part.removed?"merge-removed":"merge-context"}>{part.value.split(/(?<=\n)/).map((line,j)=><span key={j}>{part.added?"+ ":part.removed?"− ":"  "}{line}</span>)}</span>):value}</pre></details>;
}
