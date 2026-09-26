"use client";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { collabApi } from "./api";
export type LifecycleDetail = {
  organization: { name: string; lifecycle_version: string }; deleted: boolean; actorId: string;
  members: { user_id: string; name: string; role: string; email: string; active: boolean; mfa: boolean; authorization_version: string }[];
  blockers: { kind: string; count: number }[];
};
const kinds: Record<string, string> = {
  runs: "AI / 终端运行", workspaces: "尚未确认停止的工作区", snapshots: "快照", validations: "验证", integrations: "整合", promotions: "基线推进",
  github_imports: "GitHub 导入", github_syncs: "GitHub 同步", gitlab_operations: "GitLab 操作", service_previews: "动态预览", checkpoint_previews: "静态预览准备",
  resource_requests: "资源占用", resource_jobs: "资源作业", workspace_operations: "工作区 Git 操作", push_previews: "推送预览", push_confirmations: "推送确认",
  push_deliveries: "推送投递", pull_proposals: "PR 提案", pull_deliveries: "PR 创建", pull_observation_jobs: "PR 状态读取", pull_revision_jobs: "PR 代码读取",
  pull_checks_jobs: "CI 读取", pull_releases: "PR 交付", artifact_cleanup: "产物清理", workspace_environments: "环境回收",
};
export function OrganizationLifecycle({ id, detail, refresh }: { id: string; detail: LifecycleDetail; refresh: () => Promise<void> }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const candidates = detail.members.filter(member => member.active && member.user_id !== detail.actorId);
  async function submit(event: FormEvent<HTMLFormElement>, action: "delete" | "restore" | "transfer") {
    event.preventDefault(); const data = new FormData(event.currentTarget); setBusy(true); setError("");
    const target = candidates.find(member => member.user_id === data.get("targetUserId"));
    try {
      await collabApi(`organizations/${id}`, { action, expectedVersion: detail.organization.lifecycle_version, confirmation: data.get("confirmation"), reason: data.get("reason"), ...(target ? { targetUserId: target.user_id, targetVersion: target.authorization_version } : {}) });
      if (action === "restore") await refresh();
      else router.push(`/sign-in?next=${encodeURIComponent(`/organizations/${id}`)}`);
    } catch (e) { setError(e instanceof Error ? e.message : "操作失败"); }
    finally { setBusy(false); }
  }
  const fields = <><label>完整团队名称<input name="confirmation" required autoComplete="off" placeholder={detail.organization.name} /></label><label>操作原因<textarea name="reason" required minLength={10} maxLength={2000} rows={2} /></label></>;
  return <section className="collab-settings-section"><h2>所有权与团队生命周期</h2>{error && <p className="collab-error" role="alert">{error}</p>}
    {detail.deleted ? <><p>团队已删除，成员访问和旧邀请已撤销。历史、审计和文件仍保留，未执行物理清除。恢复仅重新启用你的所有者身份，其他成员须逐一重新授权。</p><form className="collab-form" onSubmit={e => void submit(e, "restore")}>{fields}<button className="collab-button primary" disabled={busy}>恢复团队</button></form></> : <>
      <h3>转让所有权</h3><p className="collab-muted">接任者需已启用多因素验证。一次提交会将对方提升为所有者，将你调整为管理员，并撤销双方旧登录会话。项目角色保持原有配置。</p>
      <form className="collab-form" onSubmit={e => void submit(e, "transfer")}><label>接任所有者<select name="targetUserId" required defaultValue=""><option value="" disabled>选择成员</option>{candidates.map(member => <option key={member.user_id} value={member.user_id} disabled={!member.mfa}>{member.name}{!member.mfa ? "（尚未启用多因素验证）" : ""}</option>)}</select></label>{fields}<button className="collab-button" disabled={busy || !candidates.some(member => member.mfa)}>确认转让所有权</button></form>
      <h3>删除团队（可恢复）</h3><p className="collab-muted">删除后所有成员立即失去访问权限并退出登录。邀请和静态预览撤销。历史、审计和文件保留；这不是物理清除。仅执行删除的所有者可在重新登录后恢复。请先停止作业，并处理结果未知的操作。</p>
      {detail.blockers.length > 0 && <div role="status"><p>删除前需要处理：</p><ul>{detail.blockers.map(item => <li key={item.kind}>{kinds[item.kind] ?? item.kind}：{item.count}</li>)}</ul></div>}
      <form className="collab-form" onSubmit={e => void submit(e, "delete")}>{fields}<button className="collab-button" disabled={busy || detail.blockers.length > 0}>删除团队并撤销访问</button></form>
    </>}
  </section>;
}
