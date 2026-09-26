"use client";
import { useCallback, useEffect, useState } from "react";
import { collabApi } from "./api";
type Artifact = { kind: string; id: string; title: string; bytes: string | null; state: string; retain_until: string; protection: string | null; cleanup_status: string | null; error_code: string | null };
type Context = { version: number; byteLimit: number; candidateDays: number; workspaceDays: number; auditDays: number; chargedBytes: string; canManage: boolean; expiredAuditCount: number; artifacts: Artifact[] };
const MiB = 1048576, size = (n: string | number | null) => n === null ? "尚未计量" : `${(Number(n) / MiB).toFixed(1)} MiB`;
const labels: Record<string, string> = { service: "动态预览副本", service_runtime_managed: "等待服务停止与退出确认后自动回收", workspace: "工作区", snapshot: "快照", validation: "验证副本", integration: "整合副本", repository: "仓库", repository_baseline: "仓库基线持续保留", workspace_not_archived: "工作区尚未归档或运行未结束", workspace_referenced: "仍有快照或 Git 操作引用", snapshot_referenced: "成果、验证、共编或讨论仍在引用", validation_referenced: "成果或预览仍在引用", integration_referenced: "修复、评审、讨论或推进记录仍在引用", retention: "尚在保留期限内", measurement_unknown: "等待完整计量", active: "作业尚未结束", active_or_unknown: "作业尚未结束或结果未知", exit_unconfirmed: "尚未确认执行进程退出", deleting: "正在回收", deleted: "文件已回收，记录保留", queued: "等待执行器处理", cancelled: "条件变化，清理已取消", attention: "清理未完成，需要重试", retained: "保留中" };
export function ArtifactStorage({ projectId }: { projectId: string }) {
  const route = `projects/${projectId}/artifacts`, [data, setData] = useState<Context | null>(null), [error, setError] = useState(""), [notice, setNotice] = useState(""), [editing, setEditing] = useState(false), [busy, setBusy] = useState(false), [selected, setSelected] = useState<Artifact | "audit" | null>(null);
  const load = useCallback(async () => { try { setData(await collabApi<Context>(route)); } catch (e) { setError(e instanceof Error ? e.message : "读取存储信息失败"); } }, [route]);
  useEffect(() => { void load(); const timer = setInterval(() => { if (!document.hidden && !editing) void load(); }, 5000); return () => clearInterval(timer); }, [load, editing]);
  async function submit(event: React.FormEvent<HTMLFormElement>, policy = false) {
    event.preventDefault(); if (!data) return; const f = new FormData(event.currentTarget); setBusy(true); setError("");
    const input = policy ? { action: "policy", expectedVersion: data.version, byteLimit: Number(f.get("byteLimitMiB")) * MiB, candidateDays: Number(f.get("candidateDays")), workspaceDays: Number(f.get("workspaceDays")), auditDays: Number(f.get("auditDays")) } : selected === "audit" ? { action: "audit", acknowledge: true } : { action: "cleanup", acknowledge: true, kind: selected?.kind, artifactId: selected?.id };
    try {
      const result = await collabApi<{ deletedCount?: number }>(route, { ...input, idempotencyKey: crypto.randomUUID(), reason: f.get("reason") });
      setNotice(policy ? "产物策略已保存。已固定的保留期限不会缩短。" : selected === "audit" ? `已清理 ${result.deletedCount} 条到期项目审计，批次摘要已留存。` : "清理请求已记录，执行器会重新核对条件后处理。"); setSelected(null); setEditing(false); await load();
    } catch (e) { setError(e instanceof Error ? e.message : "操作失败"); } finally { setBusy(false); }
  }
  return <section aria-label="产物保留与回收"><h3>产物保留与回收</h3>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {data && <><p>产物计入额度 {size(data.chargedBytes)} / {size(data.byteLimit)} · 快照和副本至少 {data.candidateDays} 天 · 归档工作区至少 {data.workspaceDays} 天 · 项目审计至少 {data.auditDays} 天</p>
      <p className="collab-small">产物额度涵盖快照、验证/整合副本、动态预览副本与仓库；工作区用量在上方单独计入。启动前预留，执行中定期计量，属于逻辑文件软配额。到期仅允许申请回收，仍被引用的来源继续保留。Git 导出、静态预览、日志和数据库未纳入此额度。</p>
      {data.canManage && <><button className="collab-button" disabled={busy} onClick={() => setEditing(!editing)}>{editing ? "取消编辑产物策略" : "配置产物保留策略"}</button>
        {editing && <form className="collab-form" onSubmit={e => void submit(e, true)} key={data.version}>
          <label>产物总额度（MiB）<input name="byteLimitMiB" type="number" min={512} max={10485760} defaultValue={data.byteLimit / MiB} required /></label>
          <label>快照及副本保留天数<input name="candidateDays" type="number" min={1} max={3650} defaultValue={data.candidateDays} required /></label>
          <label>工作区保留天数<input name="workspaceDays" type="number" min={1} max={3650} defaultValue={data.workspaceDays} required /></label>
          <label>项目审计保留天数<input name="auditDays" type="number" min={180} max={3650} defaultValue={data.auditDays} required /></label>
          <label>产物策略修改说明<textarea name="reason" minLength={10} maxLength={2000} required /></label>
          <button className="collab-button" disabled={busy}>保存产物策略</button>
        </form>}
        <p>到期项目审计 {data.expiredAuditCount} 条（每批最多 1000 条）</p><button className="collab-button" disabled={busy || !Number(data.expiredAuditCount)} onClick={() => setSelected("audit")}>清理到期项目审计</button>
      </>}
      {selected && <form className="collab-form" aria-label="确认回收" onSubmit={e => void submit(e)}>
        <p>{selected === "audit" ? "将永久删除超过保留期限的项目审计明细，并保留本批次计数和摘要。" : `将永久删除 ${labels[selected.kind]}「${selected.title}」的物理文件，保留业务记录。`}</p>
        <label>回收原因<textarea name="reason" minLength={10} maxLength={2000} required /></label>
        <label><input type="checkbox" required />我已核对对象，确认永久回收</label>
        <button className="collab-button" disabled={busy}>确认回收</button><button type="button" className="collab-button" disabled={busy} onClick={() => setSelected(null)}>取消回收</button>
      </form>}
      <details><summary>产物清单（最近 200 个）</summary>{data.artifacts.map(a => <article className="collab-result-card" key={`${a.kind}:${a.id}`}><strong>{labels[a.kind]} · {a.title}</strong><p>{size(a.bytes)} · {labels[a.state] || a.state}</p><p>{a.protection ? labels[a.protection] || a.protection : "保留期已过，当前无阻止回收的引用"}</p>{a.kind !== "service" && <p>至少保留至 {new Date(a.retain_until).toLocaleString()}</p>}{a.cleanup_status && <p role="status">{labels[a.cleanup_status] || a.cleanup_status}</p>}{data.canManage && (!a.protection || a.cleanup_status === "attention") && <button className="collab-button" disabled={busy || a.cleanup_status === "queued" || a.cleanup_status === "deleting"} onClick={() => setSelected(a)}>{a.cleanup_status === "attention" ? "重试回收" : "申请回收"}</button>}</article>)}</details>
    </>}
  </section>;
}
