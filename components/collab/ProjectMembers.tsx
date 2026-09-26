"use client";
import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { collabApi, CollabApiError } from "./api";

type Member = { user_id: string; name: string; email: string; role: string; active: boolean; organization_active: boolean; version: string; open_tasks: number };
type Task = { id: string; title: string; owner_id: string; version: number; status: string };
type Detail = { project: { name: string }; members: Member[]; tasks: Task[] };
type Audit = { id: string; actor_name: string; action: string; created_at: string; detail: Record<string, unknown> };
const roles: Record<string, string> = { maintainer: "维护者", developer: "开发者", reviewer: "评审者", viewer: "观察者" };
function auditDescription(event: Audit, members: Member[]) {
  const data = event.detail, lines: string[] = [];
  if (typeof data.reason === "string") lines.push(`原因：${data.reason}`);
  if (typeof data.previousRole === "string") lines.push(`原角色：${roles[data.previousRole] ?? data.previousRole}`);
  if (typeof data.role === "string") lines.push(`授予角色：${roles[data.role] ?? data.role}`);
  if (typeof data.active === "boolean") lines.push(`访问权限：${data.active ? "启用" : "停用"}`);
  for (const [field, label] of [["previousOwner", "原负责人"], ["ownerId", "新负责人"]]) if (typeof data[field] === "string") lines.push(`${label}：${members.find(member => member.user_id === data[field])?.name ?? "历史成员"}`);
  if (typeof data.modelId === "string") lines.push(`模型：${data.modelId}`);
  if (typeof data.baseSha === "string") lines.push(`代码基线：${data.baseSha}`);
  return lines;
}
export function ProjectMembers({ id }: { id: string }) {
  const [detail, setDetail] = useState<Detail | null>(null), [error, setError] = useState(""), [notice, setNotice] = useState(""), [busy, setBusy] = useState(false);
  const [audit, setAudit] = useState<Audit[]>([]), [cursor, setCursor] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      const [members, history] = await Promise.all([collabApi<Detail>(`projects/${id}/members`), collabApi<{ events: Audit[]; nextCursor: string | null }>(`projects/${id}/audit`)]);
      setDetail(members); setAudit(history.events); setCursor(history.nextCursor);
    } catch (error) { if (error instanceof CollabApiError && [401, 403, 404].includes(error.status)) { setDetail(null); setAudit([]); } throw error; }
  }, [id]);
  useEffect(() => { void refresh().catch(e => setError(e.message)); }, [refresh]);
  async function perform(action: () => Promise<unknown>, message: string) {
    setBusy(true); setError(""); setNotice("");
    try { await action(); setNotice(message); await refresh(); }
    catch (error) { setError(error instanceof Error ? error.message : "操作失败"); await refresh().catch(() => {}); }
    finally { setBusy(false); }
  }
  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget, fields = new FormData(form);
    await perform(async () => { await collabApi(`projects/${id}/members`, { email: fields.get("email"), role: fields.get("role") }); form.reset(); }, "成员已加入项目。");
  }
  async function change(event: FormEvent<HTMLFormElement>, member: Member) {
    event.preventDefault(); const fields = new FormData(event.currentTarget);
    await perform(() => collabApi(`projects/${id}/members/${member.user_id}`, { role: fields.get("role"), active: fields.get("active") === "on", expectedVersion: member.version }, "PATCH"), "项目权限已更新；该成员原有的排队与执行中运行将停止。");
  }
  async function reassign(event: FormEvent<HTMLFormElement>, task: Task) {
    event.preventDefault(); const fields = new FormData(event.currentTarget);
    await perform(() => collabApi(`tasks/${task.id}/owner`, { ownerId: fields.get("ownerId"), expectedVersion: task.version }, "PATCH"), "负责人已更新。旧运行先停止，新负责人需重新发起运行。");
  }
  async function older() {
    if (!cursor || busy) return; setBusy(true);
    try { const next = await collabApi<{ events: Audit[]; nextCursor: string | null }>(`projects/${id}/audit?before=${cursor}`); setAudit(previous => [...previous, ...next.events]); setCursor(next.nextCursor); }
    catch (error) { setError(error instanceof Error ? error.message : "读取失败"); }
    finally { setBusy(false); }
  }
  return <main className="collab-app collab-settings"><div className="collab-settings-content wide">
    <Link href="/">← 返回项目</Link><h1>{detail ? `${detail.project.name} · 成员管理` : "项目成员管理"}</h1>
    <p className="collab-muted">维护者管理项目权限。团队所有者与管理员需先在<Link href="/account">账户安全</Link>启用多因素验证。移除项目权限会停止该成员的运行，保留任务与历史记录。</p>
    {error && <p className="collab-error" role="alert">{error}</p>}{notice && <p className="collab-member-notice" role="status">{notice}</p>}
    {detail && <>
      <section className="collab-settings-section"><div className="collab-section-heading"><h2>项目成员</h2><button className="collab-text-button" disabled={busy} onClick={() => void refresh().catch(e => setError(e.message))}>刷新成员</button></div>
        {detail.members.map(member => <form className="collab-member-settings collab-project-member-settings" key={`${member.user_id}-${member.version}-${member.organization_active}`} onSubmit={event => void change(event, member)}>
          <div><strong>{member.name}</strong><small>{member.email}</small><small>{member.open_tasks} 项未完成任务{!member.organization_active ? " · 团队资格已停用" : !member.active ? " · 项目资格已停用" : ""}</small></div>
          <label>项目角色<select name="role" aria-label={`${member.name} 的项目角色`} defaultValue={member.role} disabled={busy}>{Object.entries(roles).map(([role, name]) => <option key={role} value={role}>{name}</option>)}</select></label>
          <label className="collab-checkbox"><input type="checkbox" name="active" aria-label={`${member.name} 的项目访问`} defaultChecked={member.active} disabled={busy} />项目访问</label>
          <button className="collab-button" disabled={busy}>保存权限</button>
        </form>)}
      </section>
      <section className="collab-settings-section"><h2>添加已有团队成员</h2><p className="collab-muted">输入已加入团队的成员邮箱；新用户需先接受团队邀请。停用过的项目成员请在上方重新授权。</p>
        <form className="collab-form" onSubmit={add}><label>成员邮箱<input type="email" name="email" required /></label><label>授予项目角色<select name="role" defaultValue="developer">{Object.entries(roles).map(([role, name]) => <option key={role} value={role}>{name}</option>)}</select></label><button className="collab-button primary" disabled={busy}>添加到项目</button></form>
      </section>
      <section className="collab-settings-section"><h2>任务交接</h2><p className="collab-muted">重新分配负责人会停止该任务的旧运行。未确认结束的运行仍会阻止新运行启动。</p>
        {detail.tasks.length ? detail.tasks.map(task => <form className="collab-task-assignment" key={`${task.id}-${task.version}`} onSubmit={event => void reassign(event, task)}>
          <div><strong>{task.title}</strong><small>当前负责人：{detail.members.find(m => m.user_id === task.owner_id)?.name ?? "已离开成员"}</small></div>
          <label>新负责人<select name="ownerId" aria-label={`${task.title} 的新负责人`} defaultValue={detail.members.some(m => m.user_id === task.owner_id && m.active && m.organization_active && ["maintainer", "developer"].includes(m.role)) ? task.owner_id : ""} required disabled={busy}>
            <option value="" disabled>选择负责人</option>{detail.members.filter(m => m.active && m.organization_active && ["maintainer", "developer"].includes(m.role)).map(member => <option key={member.user_id} value={member.user_id}>{member.name}</option>)}
          </select></label><button className="collab-button" disabled={busy}>转交任务</button>
        </form>) : <p className="collab-muted">暂无未完成任务。</p>}
      </section>
      <section className="collab-settings-section"><h2>项目审计记录</h2>{audit.map(event => <div className="collab-project-audit" key={event.id}><strong>{event.actor_name}</strong><span>{({ "project.member_added": "添加项目成员", "project.member_changed": "修改项目权限", "project.emergency_access": "应急接管项目", "task.reassigned": "转交任务" } as Record<string, string>)[event.action] ?? event.action}</span><time>{new Date(event.created_at).toLocaleString()}</time>{auditDescription(event, detail.members).length > 0 && <details><summary>查看变更详情</summary>{auditDescription(event, detail.members).map((line, index) => <p className="collab-prewrap" key={index}>{line}</p>)}</details>}</div>)}{cursor && <button className="collab-button" disabled={busy} onClick={() => void older()}>加载更早记录</button>}</section>
    </>}
  </div></main>;
}
