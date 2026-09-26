"use client";
import { useState } from "react";
export interface PromotionSummary {
  id: string; status: string; promotion_sha: string; stop_requested: boolean; error_code: string | null;
}
const names: Record<string, string> = {
  queued: "等待本地推进", preparing: "核验固定代码", applying: "推进结果待确认", unknown: "推进结果未知", reconcile_queued: "等待 Git 对账",
  reconciling: "核对 Git 决定", blocked: "目标分支异常 · 保持占用", applied: "已推进本地基线", aborted: "已封闭推进 · 未写入目标",
};
export function IntegrationPromotions({ id, role, target, candidate, branch, revision, ready, promotions, excluded, disabled, submit }: {
  id: string; role: string; target: string; candidate: string | null; branch: string; revision: string | null; ready: boolean;
  promotions: PromotionSummary[]; excluded: { path: string; reason: string }[]; disabled: boolean;
  submit: (endpoint: string, body: unknown) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<{ revision: string; reason: string; acknowledged: boolean } | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const occupied = promotions.some(p => !["applied", "aborted"].includes(p.status)), maintainer = role === "maintainer";
  return <section aria-label="本地 Git 推进" className="collab-form compact">
    {promotions.map(p => <div key={p.id} aria-label={`推进 ${p.id}`} className="collab-form compact">
      <strong role="status">{names[p.status]}</strong>
      <p className="collab-small" style={{ overflowWrap: "anywhere" }}>推进提交 {p.promotion_sha}</p>
      {p.stop_requested && !["applied", "aborted"].includes(p.status) && <p className="collab-muted collab-small">已申请停止；需要确认 Git 的终态才能释放目标。已发生的写入会按实际结果记录。</p>}
      {["unknown", "blocked"].includes(p.status) && <p className="collab-muted collab-small">本目标继续占用。对账只确认已发生的写入或封闭未执行操作；不会重新应用候选、重置分支或采纳外部变更。异常目标需要本机管理员核查。</p>}
      {p.error_code && <p className="collab-muted collab-small">诊断代码：{p.error_code}</p>}
      <a className="collab-text-button" href={`/api/collab/promotions/${p.id}`} download>查看推进证据</a>
      {maintainer && !["applied", "aborted", "reconcile_queued", "reconciling"].includes(p.status) && <form className="collab-form compact" onSubmit={async e => {
        e.preventDefault(); await submit(`promotions/${p.id}`, { action: ["unknown", "blocked"].includes(p.status) ? "reconcile" : "cancel", reason: reasons[p.id] ?? "", idempotencyKey: crypto.randomUUID() });
      }}>
        <label>推进处理原因<textarea aria-label="推进处理原因" required minLength={10} maxLength={2000} value={reasons[p.id] ?? ""} disabled={disabled} onChange={e => setReasons({ ...reasons, [p.id]: e.target.value })}/></label>
        <button className="collab-button" disabled={disabled || (p.stop_requested && !["unknown", "blocked"].includes(p.status))}>{["unknown", "blocked"].includes(p.status) ? "申请 Git 对账" : "请求停止推进"}</button>
      </form>}
    </div>)}
    {maintainer && ready && revision && candidate && !occupied && <details><summary>推进本地 Git 基线</summary>
      <p className="collab-small">需要维护者启用多因素验证。执行前会重新检查权限、全部必跑检查、独立批准、修改要求和固定输入。</p>
      <p className="collab-small" style={{ overflowWrap: "anywhere" }}>分支 {branch}<br/>当前基线 {target}<br/>已评审候选 {candidate}</p>
      <p className="collab-muted collab-small">平台将在候选之后添加同代码树的溯源提交，因此最终 SHA 与候选不同；申请记录会显示固定的最终 SHA。操作只推进平台管理的本地仓库，远程发布需要独立流程。</p>
      <p className="collab-small">检查未涵盖的路径：{excluded.length ? excluded.map(e => e.path).join("、") : "无已记录排除项"}。原基线中的排除内容只允许原样保留；其内容未被本次验证。</p>
      {!draft ? <button className="collab-button" disabled={disabled} onClick={() => setDraft({ revision, reason: "", acknowledged: false })}>准备本地推进</button> : <form className="collab-form compact" onSubmit={async e => {
        e.preventDefault();
        if (await submit(`integrations/${id}/promotions`, { revisionHash: draft.revision, acknowledgeExcluded: draft.acknowledged, reason: draft.reason, idempotencyKey: crypto.randomUUID() })) setDraft(null);
      }}>
        {draft.revision !== revision && <p className="collab-error">评审版本已变化，请取消后重新准备。</p>}
        <label>推进说明<textarea aria-label="推进说明" required minLength={10} maxLength={2000} disabled={disabled} value={draft.reason} onChange={e => setDraft({ ...draft, reason: e.target.value })}/></label>
        <label className="collab-checkbox"><input type="checkbox" required disabled={disabled} checked={draft.acknowledged} onChange={e => setDraft({ ...draft, acknowledged: e.target.checked })}/><span>我确认固定候选与同代码树溯源提交，并理解排除内容未被验证、仅保留原样。</span></label>
        <button className="collab-button" disabled={disabled || !draft.acknowledged || draft.revision !== revision}>确认推进本地基线</button>
        <button className="collab-button" type="button" disabled={disabled} onClick={() => setDraft(null)}>取消准备推进</button>
      </form>}
    </details>}
  </section>;
}
