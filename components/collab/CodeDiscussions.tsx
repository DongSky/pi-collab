"use client";
import { useEffect, useState } from "react";
import { collabApi } from "./api";
import { TaskDiscussions } from "./TaskDiscussions";
import type { ReviewAnchor, ReviewDiscussionContext } from "@/lib/collab/review-discussion-schema";
export function CodeDiscussions({ kind, sourceId, diffHash, path, side, line }: Omit<ReviewAnchor,"sourceHash"|"startLine"|"endLine"> & { line: number }) {
 const [context,setContext]=useState<ReviewDiscussionContext|null>(null),[task,setTask]=useState(""),[end,setEnd]=useState(line),[error,setError]=useState("");
 useEffect(()=>{let alive=true;void collabApi<ReviewDiscussionContext>(`review-discussions?${new URLSearchParams({kind,sourceId})}`).then(data=>{if(alive){setContext(data);setTask(data.tasks[0]?.id??"");}}).catch(e=>{if(alive)setError(e.message);});return()=>{alive=false;};},[kind,sourceId]);
 return <section className="collab-form compact" aria-label="固定差异行内讨论">
  <h4>讨论所选代码</h4><p className="collab-small collab-git-identity">{path} · {side==="before"?"旧侧":"新侧"}第 {line} 行 · 差异 {diffHash.slice(0,12)}</p>
  {error&&<p role="alert">{error}</p>}
  {context&&<><label>关联任务<select aria-label="代码讨论关联任务" value={task} onChange={e=>setTask(e.target.value)}>{context.tasks.map(t=><option key={t.id} value={t.id}>{t.title}</option>)}</select></label><label>讨论结束行<input aria-label="讨论结束行" type="number" min={line} max={8000} value={end} onChange={e=>setEnd(Number(e.target.value))}/></label>
   {task&&<TaskDiscussions key={task} taskId={task} userId={context.userId} members={context.members} snapshots={[]} canApply={false} onApply={()=>{}} onRestoreReviewRange={setEnd} fixedReviewAnchor={{kind,sourceId,sourceHash:context.sourceHash,diffHash,path,side,startLine:line,endLine:end}}/>}
  </>}
 </section>;
}
