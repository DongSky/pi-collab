"use client";
import { useState } from "react";
export type IntegrationPolicy = {
  id: string; repository_id: string; target_branch: string; version: number; profile_id: string;
  required_approvals: number; reviewer_approvals: boolean; reason: string; profile_name: string;
  config: { steps: { tool: string; args: string[]; timeoutSeconds: number }[] };
};
export type IntegrationReviewState = {
  policyId: string | null; policyVersion: number | null; requiredApprovals: number | null; reviewerApprovals: boolean | null;
  policyCurrent: boolean; revisionHash: string | null; current: boolean; approvals: number; blockers: number;
  reviewSatisfied: boolean; canReview: boolean; contributor: boolean; ownVersion: number;
  reviews: { id: string; reviewerId: string; reviewerName: string; version: number; decision: string; note: string; authorized: boolean; counts: boolean; createdAt: string }[];
};
type Submit = (endpoint: string, body: unknown) => Promise<boolean>;
export function IntegrationPolicyEditor({ projectId, repositories, profiles, policies, disabled, submit }: {
  projectId: string; repositories: { id: string; name: string }[]; profiles: { id: string; name: string; repository_id: string }[];
  policies: IntegrationPolicy[]; disabled: boolean; submit: Submit;
}) {
  const [repositoryId, setRepositoryId] = useState("");
  const [draft, setDraft] = useState<{ version: number; profileId: string; approvals: number; reviewers: boolean; reason: string } | null>(null);
  const policy = policies.find(p => p.repository_id === repositoryId);
  return <details><summary>维护者：设置整合规则</summary>
    <p className="collab-muted collab-small">每个版本指定一份必跑配置（其中所有步骤都必须通过）和 1–3 位独立评审者。发布新规则会使旧整合和批准失效。</p>
    <label>规则仓库<select aria-label="规则仓库" value={repositoryId} disabled={disabled} onChange={e => { setRepositoryId(e.target.value); setDraft(null); }}>
      <option value="">选择仓库</option>{repositories.map(r => <option value={r.id} key={r.id}>{r.name}</option>)}
    </select></label>
    {repositoryId && <p className="collab-muted collab-small">{policy ? `当前规则 v${policy.version} · ${policy.profile_name} · 需要 ${policy.required_approvals} 位批准` : "尚未设置规则；预演不能完成正式评审。"}</p>}
    {repositoryId && !draft && <button className="collab-button" disabled={disabled} onClick={() => setDraft({ version: policy?.version ?? 0, profileId: policy?.profile_id ?? "", approvals: policy?.required_approvals ?? 1, reviewers: policy?.reviewer_approvals ?? true, reason: "" })}>编辑整合规则</button>}
    {draft && <form className="collab-form compact" onSubmit={async e => {
      e.preventDefault();
      if (await submit(`projects/${projectId}/integration-policies`, { repositoryId, profileId: draft.profileId, requiredApprovals: draft.approvals, reviewerApprovals: draft.reviewers, expectedVersion: draft.version, reason: draft.reason, idempotencyKey: crypto.randomUUID() })) setDraft(null);
    }}>
      <p className="collab-muted collab-small">正在修改规则 v{draft.version}。其他维护者更新后，本次提交需要重新编辑。</p>
      <label>必跑验证配置<select aria-label="必跑验证配置" required disabled={disabled} value={draft.profileId} onChange={e => setDraft({ ...draft, profileId: e.target.value })}><option value="">选择配置</option>{profiles.filter(p => p.repository_id === repositoryId).map(p => <option key={p.id} value={p.id}>{p.name} · {p.id.slice(0,8)}</option>)}</select></label>
      <label>所需批准人数<select aria-label="所需批准人数" disabled={disabled} value={draft.approvals} onChange={e => setDraft({ ...draft, approvals: Number(e.target.value) })}>{[1,2,3].map(n => <option key={n} value={n}>{n}</option>)}</select></label>
      <label><input type="checkbox" checked={draft.reviewers} disabled={disabled} onChange={e => setDraft({ ...draft, reviewers: e.target.checked })}/>Reviewer 角色的批准计入人数</label>
      <label>规则变更原因<textarea aria-label="规则变更原因" required minLength={10} maxLength={2000} disabled={disabled} value={draft.reason} onChange={e => setDraft({ ...draft, reason: e.target.value })}/></label>
      <button className="collab-button" disabled={disabled}>发布整合规则</button>
      <button className="collab-button" type="button" disabled={disabled} onClick={() => setDraft(null)}>取消编辑规则</button>
    </form>}
  </details>;
}
const decisions: Record<string,string> = { approve: "批准", request_changes: "要求修改", withdraw: "撤回评审" };
export function IntegrationReviews({ id, state, disabled, submit }: { id: string; state: IntegrationReviewState; disabled: boolean; submit: Submit }) {
  const [draft, setDraft] = useState<{ revision: string; version: number; decision: string; note: string } | null>(null);
  const staleDraft = draft && (draft.revision !== state.revisionHash || draft.version !== state.ownVersion);
  return <div aria-label="整合评审">
    {!state.policyId ? <p className="collab-muted collab-small">未绑定必跑规则，仅供预演；请制定规则后重新创建整合。</p> : <>
      <p className="collab-small">规则 v{state.policyVersion} · 有效批准 {state.approvals}/{state.requiredApprovals} · 待解决修改要求 {state.blockers}</p>
      {!state.policyCurrent && <p className="collab-error">整合规则已更新，需要重新组合并检查。</p>}
      {state.reviewSatisfied && <p role="status">检查与评审条件已满足 · 可申请本地推进</p>}
      {state.revisionHash && <p className="collab-muted collab-small">评审版本 {state.revisionHash.slice(0,16)}</p>}
      {state.reviews.map(r => <div key={r.id} className="collab-small collab-prewrap"><strong>{decisions[r.decision]} · {r.reviewerName} · 第 {r.version} 次</strong><p>{r.note}</p>
        {r.decision === "approve" && !r.counts && <p className="collab-muted">此批准不计入当前条件（规则、权限或代码版本不匹配）。</p>}
        {r.decision === "request_changes" && <p className="collab-muted">由原评审者撤回或更新决定后解除；停用成员不会自动消除修改要求。</p>}
      </div>)}
      {state.canReview && <details><summary>提交版本评审</summary>
        <p className="collab-muted collab-small">整合申请人、来源运行发起人和成果发布人不能批准本组合。评审只适用于下方证据中的固定代码；不会更新 Git 分支。</p>
        {!state.reviewerApprovals && <p className="collab-muted collab-small">本规则只计入 Maintainer 和 Developer 的批准；Reviewer 仍可提出修改要求。</p>}
        {!draft ? <button className="collab-button" disabled={disabled} onClick={() => setDraft({ revision: state.revisionHash!, version: state.ownVersion, decision: state.contributor ? "request_changes" : "approve", note: "" })}>开始本次评审</button> : <form className="collab-form compact" onSubmit={async e => {
          e.preventDefault();
          if (await submit(`integrations/${id}/reviews`, { revisionHash: draft.revision, expectedVersion: draft.version, decision: draft.decision, note: draft.note, idempotencyKey: crypto.randomUUID() })) setDraft(null);
        }}>
          {staleDraft && <p className="collab-error">本次评审版本已变化，请取消编辑并重新开始。</p>}
          <label>评审决定<select aria-label="评审决定" value={draft.decision} disabled={disabled} onChange={e => setDraft({ ...draft, decision: e.target.value })}>{Object.entries(decisions).map(([key,label]) => <option key={key} value={key} disabled={key === "approve" && state.contributor}>{label}</option>)}</select></label>
          <label>评审说明<textarea aria-label="评审说明" required minLength={10} maxLength={4000} value={draft.note} disabled={disabled} onChange={e => setDraft({ ...draft, note: e.target.value })}/></label>
          <button className="collab-button" disabled={disabled || !!staleDraft}>保存版本评审</button>
          <button className="collab-button" type="button" disabled={disabled} onClick={() => setDraft(null)}>取消编辑评审</button>
        </form>}
      </details>}
    </>}
  </div>;
}
