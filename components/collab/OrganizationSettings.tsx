"use client";
import Link from "next/link";
import { OrganizationLifecycle, type LifecycleDetail } from "./OrganizationLifecycle";
import { OidcSettings } from "./OidcSettings";
import { Administration } from "./Administration";
import { GitHubConnections } from "./GitHubConnections";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { collabApi, CollabApiError } from "./api";

type Member = { user_id: string; name: string; email: string; role: string; active: boolean };
type Invitation = { id: string; email: string; role: string; expires_at: string; accepted_at: string | null; revoked_at: string | null };
type Detail = LifecycleDetail & { organization: { name: string }; role: string; members: Member[]; invitations: Invitation[]; projects: { id: string; name: string }[]; governance: { id: string; name: string; ownRole: string | null; maintainers: number }[] };
const roles: Record<string, string> = { owner: "所有者", admin: "管理员", member: "成员" };
export function OrganizationSettings({ id }: { id: string }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [inviteUrl, setInviteUrl] = useState("");
  const refresh = useCallback(async () => {
    try { setDetail(await collabApi<Detail>(`organizations/${id}`)); setError(""); }
    catch (e) { if (e instanceof CollabApiError && [401,403,404].includes(e.status)) { setDetail(null); setInviteUrl(""); } throw e; }
  }, [id]);
  useEffect(() => { void refresh().catch(e => setError(e.message)); }, [refresh]);
  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); setInviteUrl("");
    const fields = new FormData(event.currentTarget);
    try {
      const result = await collabApi<{ url: string }>(`organizations/${id}/invitations`, {
        email: fields.get("email"), role: fields.get("role"),
        ...(fields.get("projectId") ? { projectId: fields.get("projectId"), projectRole: fields.get("projectRole") } : {}),
      });
      setInviteUrl(result.url); await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "邀请失败"); }
    finally { setBusy(false); }
  }
  async function member(event: FormEvent<HTMLFormElement>, target: string) {
    event.preventDefault(); setBusy(true); setError("");
    const fields = new FormData(event.currentTarget);
    try { await collabApi(`organizations/${id}/members/${target}`, { role: fields.get("role"), active: fields.get("active") === "on" }, "PATCH"); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : "修改失败"); }
    finally { setBusy(false); }
  }
  async function revoke(invitation: Invitation) {
    setBusy(true); setError("");
    try { await collabApi(`organizations/${id}/invitations/${invitation.id}`, undefined, "DELETE"); setInviteUrl(""); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : "撤销失败"); }
    finally { setBusy(false); }
  }
  async function recover(event: FormEvent<HTMLFormElement>, projectId: string) {
    event.preventDefault(); const fields = new FormData(event.currentTarget); setBusy(true); setError("");
    try { await collabApi(`projects/${projectId}/recover`, { reason: fields.get("reason") }); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : "接管失败"); }
    finally { setBusy(false); }
  }
  return <main className="collab-app collab-settings"><div className="collab-settings-content wide"><Link href="/">← 返回项目</Link><div className="collab-section-heading"><h1>{detail?.organization.name ?? "团队管理"}</h1><button className="collab-text-button" disabled={busy} onClick={() => void refresh().catch(e => setError(e.message))}>刷新团队信息</button></div>{detail && <p className="collab-muted">邀请与成员变更需要<Link href="/account">启用多因素验证</Link>。调整成员权限会撤销该成员的已有登录会话。</p>}
    {detail?.role === "owner" && <OrganizationLifecycle id={id} detail={detail} refresh={refresh} />}
    {error && <p role="alert" className="collab-error">{error}</p>}
    {detail && !detail.deleted && <><section className="collab-settings-section"><h2>邀请成员</h2><form className="collab-form" onSubmit={invite}>
      <label>受邀邮箱<input type="email" name="email" required /></label><label>团队角色<select name="role"><option value="member">成员</option>{detail.role === "owner" && <option value="admin">管理员</option>}</select></label>
      <label>同时加入项目<select name="projectId"><option value="">暂不加入项目</option>{detail.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
      <label>项目角色<select name="projectRole"><option value="developer">开发者</option><option value="reviewer">评审者</option><option value="viewer">观察者</option><option value="maintainer">维护者</option></select></label><button className="collab-button primary" disabled={busy}>创建邀请链接</button>
    </form>{inviteUrl && <div className="collab-form collab-invite-result" role="status"><label>邀请链接（仅此次显示，48 小时有效）<input readOnly value={inviteUrl} onFocus={e => e.target.select()} /></label><p className="collab-muted">请私下分享给受邀邮箱的持有人。</p></div>}</section>
    <section className="collab-settings-section"><h2>团队成员</h2>{detail.members.map(item => <form className="collab-member-settings" key={`${item.user_id}-${item.role}-${item.active}`} onSubmit={event => void member(event, item.user_id)}>
      <div><strong>{item.name}</strong><small>{item.email}</small></div><label>角色<select name="role" aria-label={`${item.name} 的角色`} defaultValue={item.role} disabled={busy || (detail.role === "admin" && item.role !== "member")}>
        {(detail.role === "owner" ? ["owner", "admin", "member"] : [item.role]).map(role => <option value={role} key={role}>{roles[role]}</option>)}</select></label>
      <label className="collab-checkbox"><input type="checkbox" name="active" defaultChecked={item.active} disabled={busy || (detail.role === "admin" && item.role !== "member")} />启用</label><button className="collab-button" disabled={busy || (detail.role === "admin" && item.role !== "member")}>保存</button>
    </form>)}</section>
    <section className="collab-settings-section"><h2>项目治理与应急接管</h2><p className="collab-muted">团队管理员可查看项目名称和维护者数量；查看项目内容需要项目成员资格。应急加入会授予你维护者权限，原因记入项目审计。</p>
      {detail.governance.map(project => <div className="collab-governance-row" key={project.id}><strong>{project.name}</strong><small>{project.maintainers} 位有效维护者{project.maintainers === 0 ? " · 需要接管" : ""}</small>
        {project.ownRole === "maintainer" ? <Link href={`/projects/${project.id}/members`}>管理项目成员</Link> : <form className="collab-form" onSubmit={event => void recover(event, project.id)}><label>应急接管原因<textarea name="reason" aria-label={`${project.name} 的接管原因`} required minLength={10} maxLength={2000} rows={2} placeholder="说明接管的必要性和后续安排" /></label><button className="collab-button" disabled={busy}>应急加入项目</button></form>}
      </div>)}
    </section>
    <OidcSettings organizationId={id}/>
    <GitHubConnections organizationId={id}/>
    <Administration organizationId={id}/>
    <section className="collab-settings-section"><h2>邀请记录</h2>{detail.invitations.map(item => <div className="collab-session" key={item.id}><div><strong>{item.email}</strong><small>{roles[item.role]} · {item.accepted_at ? "已接受" : item.revoked_at ? "已撤销" : `到期 ${new Date(item.expires_at).toLocaleString()}`}</small></div>{!item.accepted_at && !item.revoked_at && <button className="collab-button" disabled={busy || (detail.role === "admin" && item.role === "admin")} onClick={() => void revoke(item)}>撤销邀请</button>}</div>)}</section></>}
  </div></main>;
}
