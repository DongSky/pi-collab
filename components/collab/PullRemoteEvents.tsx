"use client";
import { useEffect, useState } from "react";
import type { PullRemoteContext } from "@/lib/collab/git/github-webhook";
import { collabApi } from "./api";
export function PullRemoteEvents({ changeId }: { changeId: string }) {
  const [context, setContext] = useState<PullRemoteContext | null>(null), [error, setError] = useState("");
  useEffect(() => {
    let alive = true, serial = 0;
    const load = async () => { const current = ++serial; try { const data = await collabApi<PullRemoteContext>("pull-changes/"+changeId+"/remote-events"); if (alive && current===serial) { setContext(data); setError(""); } }
      catch { if (alive && current===serial) { setContext(null); setError("远端通知状态暂不可用，请稍后刷新。"); } } };
    void load(); const timer = setInterval(() => { if (!document.hidden) void load(); }, 3000);
    return () => { alive=false; clearInterval(timer); };
  }, [changeId]);
  return <section className="collab-form compact" aria-label="PR 远端变更通知">
    {error && <p role="alert">{error}</p>}
    {context && <><p className="collab-small">{context.configured ? "已配置签名事件接收；未收到通知不代表远端没有变化。" : "尚未配置签名事件接收，请显式读取远端状态和 CI。"}</p>
      {context.needsRefresh && <p role="status">远端变更通知已使旧代码证据失效，请重新读取 PR 状态，再获取固定代码版本和 CI。</p>}
      {!!context.events.length && <details><summary>已验证的远端通知（最近 20 条）</summary>
        <p className="collab-small">通知只使旧证据失效；重复投递不会再次生效，乱序通知不会恢复旧结果。</p>
        {context.events.map(event => <p className="collab-small collab-git-identity" key={event.id}>{event.event}{event.action && " · "+event.action} · {new Date(event.receivedAt).toLocaleString()}<br/>SHA {event.headSha}</p>)}
      </details>}
    </>}
  </section>;
}
