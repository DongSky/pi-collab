"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { checksPolicyInput, pullChecksRequest, pullChecksCancel, type ChecksConfig, type PullChecksContext } from "@/lib/collab/git/pull-checks-schema";
import { collabApi, CollabApiError } from "./api";
const pendingSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("policy"), body: checksPolicyInput }).strict(),
  z.object({ kind: z.literal("read"), body: pullChecksRequest }).strict(),
  z.object({ kind: z.literal("cancel"), jobId: z.uuid(), body: pullChecksCancel }).strict(),
]);
type Pending = z.infer<typeof pendingSchema>;
const states: Record<string, string> = { queued: "等待 CI 读取", running: "正在核对固定版本 CI", observed: "已保存 CI 观察", failed: "CI 读取失败", cancelled: "CI 读取已取消" };
const verdicts: Record<string, string> = { passed: "通过", failed: "未通过", pending: "尚未完成", missing: "缺少指定生产者的检查", ambiguous: "存在多项同名检查，无法确认" };
export function PullChecks({ revisionId, userId }: { revisionId: string; userId: string }) {
  const [context, setContext] = useState<PullChecksContext | null>(null), [pending, setPending] = useState<Pending | null>(null);
  const [loaded, setLoaded] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(""), [reason, setReason] = useState("");
  const [draft, setDraft] = useState<{ expectedVersion: number; config: ChecksConfig; reason: string } | null>(null);
  const alive = useRef(true), writing = useRef(false), sequence = useRef(0);
  const key = "pi-collab:pull-checks:" + userId + ":" + revisionId, route = "pull-revisions/" + revisionId;
  const refresh = useCallback(async () => {
    const current = ++sequence.current;
    try { const value = await collabApi<PullChecksContext>(route + "/checks"); if (alive.current && current === sequence.current) setContext(value); }
    catch (e) { if (alive.current && current === sequence.current) { setContext(null); setError(e instanceof Error ? e.message : "CI 记录读取失败"); } }
  }, [route]);
  useEffect(() => {
    alive.current = true;
    try { const saved = sessionStorage.getItem(key); setPending(saved ? pendingSchema.parse(JSON.parse(saved)) : null); }
    catch { setError("无法恢复原 CI 操作编号，请核对已有记录。"); }
    setLoaded(true); void refresh();
    const visible = () => { if (!document.hidden) void refresh(); }, timer = setInterval(visible, 3000);
    window.addEventListener("online", visible); document.addEventListener("visibilitychange", visible);
    return () => { alive.current = false; clearInterval(timer); window.removeEventListener("online", visible); document.removeEventListener("visibilitychange", visible); };
  }, [key, refresh]);
  async function submit(value: Pending) {
    if (writing.current || !loaded || !context) return;
    const parsed = pendingSchema.safeParse(pending ?? value);
    if (!parsed.success) { setError("请核对检查名称、App ID、规则版本和至少 10 个字符的原因。"); return; }
    const fixed = parsed.data;
    if (fixed.kind === "policy" ? !context.canConfigure : !context.canCancel) return;
    try { sessionStorage.setItem(key, JSON.stringify(fixed)); }
    catch { setError("无法保留原请求编号，尚未提交。"); return; }
    writing.current = true; setBusy(true); setPending(fixed); setError("");
    try {
      await collabApi(fixed.kind === "policy" ? route + "/checks-policy" : fixed.kind === "read" ? route + "/checks" : "pull-checks/" + fixed.jobId + "/cancel", fixed.body);
      sessionStorage.removeItem(key); if (alive.current) { setPending(null); setDraft(null); setReason(""); }
    } catch (e) {
      if (e instanceof CollabApiError && e.status < 500) { sessionStorage.removeItem(key); if (alive.current) setPending(null); }
      if (alive.current) setError(e instanceof Error ? e.message : "CI 响应未知，请重试原请求");
    } finally { writing.current = false; setBusy(false); if (alive.current) await refresh(); }
  }
  const active = context?.jobs.some(j => ["queued", "running"].includes(j.status)), policy = context?.policy;
  return <details className="collab-form compact" aria-label="固定版本 CI"><summary>固定版本 CI 规则与结果</summary>
    <p className="collab-small">读取此 head SHA 的 GitHub Check Runs，按检查名称和 App ID 核对来源。只有全部指定检查成功且观察未过期才符合规则；这不代表评审或受保护合并已通过。</p>
    {error && <p role="alert" className="collab-error">{error}</p>}
    <button className="collab-button secondary" onClick={() => void refresh()}>刷新已有 CI 记录</button>
    {policy ? <section aria-label="当前 CI 规则"><p>CI 规则 v{policy.version} · 观察有效期 {policy.config.maxAgeSeconds} 秒</p>
      {policy.config.required.map(r => <p className="collab-small collab-git-identity" key={r.name + ":" + r.appId}>{r.name} · GitHub App {r.appId}</p>)}
    </section> : <p>尚未配置 CI 规则。项目维护者启用 MFA 后可以指定可信检查生产者。</p>}
    {pending && <button className="collab-button" disabled={busy || (pending.kind === "policy" ? !context?.canConfigure : !context?.canCancel)} onClick={() => void submit(pending)}>重试同一 CI 操作</button>}
    {context?.canConfigure && !pending && !draft && <button className="collab-button" disabled={!loaded || busy} onClick={() => setDraft({ expectedVersion: policy?.version ?? 0,
      config: policy ? structuredClone(policy.config) : { version: 1, required: [{ name: "", appId: "" }], maxAgeSeconds: 600 }, reason: "" })}>编辑 CI 规则</button>}
    {draft && context?.canConfigure && <form className="collab-form compact" onSubmit={e => { e.preventDefault(); void submit({ kind: "policy", body: { ...draft, idempotencyKey: crypto.randomUUID() } }); }}>
      <p className="collab-small">这些生产者将被信任为此目标分支提供检查。App ID 只证明来源，维护者仍需核验其工作流和凭据配置。</p>
      {draft.config.required.map((rule, i) => <div className="collab-form compact" key={i}>
        <label>检查名称 {i + 1}<input aria-label={"CI 检查名称 " + (i + 1)} required maxLength={200} value={rule.name} onChange={e => setDraft({ ...draft, config: { ...draft.config, required: draft.config.required.map((r,n) => n === i ? { ...r, name: e.target.value } : r) } })}/></label>
        <label>GitHub App ID {i + 1}<input aria-label={"CI App ID " + (i + 1)} required pattern="[1-9][0-9]{0,15}" value={rule.appId} onChange={e => setDraft({ ...draft, config: { ...draft.config, required: draft.config.required.map((r,n) => n === i ? { ...r, appId: e.target.value } : r) } })}/></label>
        {draft.config.required.length > 1 && <button type="button" className="collab-button secondary" onClick={() => setDraft({ ...draft, config: { ...draft.config, required: draft.config.required.filter((_,n) => n !== i) } })}>移除检查 {i + 1}</button>}
      </div>)}
      {draft.config.required.length < 16 && <button type="button" className="collab-button secondary" onClick={() => setDraft({ ...draft, config: { ...draft.config, required: [...draft.config.required, { name: "", appId: "" }] } })}>添加必需 CI 检查</button>}
      <label>观察有效期（秒）<input aria-label="CI 观察有效期" type="number" min={30} max={3600} required value={draft.config.maxAgeSeconds} onChange={e => setDraft({ ...draft, config: { ...draft.config, maxAgeSeconds: Number(e.target.value) } })}/></label>
      <label>规则变更原因<textarea aria-label="CI 规则变更原因" minLength={10} maxLength={2000} required value={draft.reason} onChange={e => setDraft({ ...draft, reason: e.target.value })}/></label>
      {draft.expectedVersion !== (policy?.version ?? 0) && <p>CI 规则已变化，请取消编辑后重新开始。</p>}
      <button className="collab-button" disabled={busy || !!pending || draft.expectedVersion !== (policy?.version ?? 0)}>发布 CI 规则</button>
      <button type="button" className="collab-button secondary" onClick={() => setDraft(null)}>取消编辑 CI 规则</button>
    </form>}
    {context?.canRequest && policy && !pending && <button className="collab-button" disabled={!loaded || busy || active} onClick={() => void submit({ kind: "read", body: {
      idempotencyKey: crypto.randomUUID(), expectedTaskVersion: context.taskVersion, expectedPolicyId: policy.id,
    } })}>读取此版本 GitHub CI</button>}
    {context?.jobs.map(job => <article className="collab-form compact" key={job.jobId} data-pull-checks={job.jobId}>
      <p role="status">{states[job.status]}</p>
      {job.status === "observed" && <p role="status">{job.eligible ? "检查符合当前 CI 规则" : job.satisfied ? "历史检查成功 · 已过期或被新规则、版本、读取替代" : "检查未满足指定 CI 规则"}</p>}
      <p className="collab-small collab-git-identity">读取成员 {job.actorName}<br/>读取编号 {job.jobId}{job.evidenceHash && <><br/>证据 SHA-256 {job.evidenceHash}</>}</p>
      {job.rules?.map(r => <p className="collab-small collab-git-identity" key={r.name + ":" + r.appId}>{r.name} · App {r.appId} · {verdicts[r.state]}{r.checkId && " · 检查 " + r.checkId}</p>)}
      {job.failure && <details><summary>CI 读取诊断</summary><p>{job.failure}</p></details>}
      {job.stopRequested && <p>已记录取消请求。</p>}
      {context.canCancel && !pending && ["queued", "running"].includes(job.status) && !job.stopRequested && <form className="collab-form compact" onSubmit={e => { e.preventDefault(); void submit({ kind: "cancel", jobId: job.jobId, body: { idempotencyKey: crypto.randomUUID(), reason } }); }}>
        <label>CI 读取取消原因<textarea aria-label="CI 读取取消原因" required minLength={10} maxLength={2000} value={reason} onChange={e => setReason(e.target.value)}/></label>
        <button className="collab-button secondary" disabled={busy}>取消此次 CI 读取</button>
      </form>}
    </article>)}
  </details>;
}
