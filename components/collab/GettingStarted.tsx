"use client";
import { useCallback, useEffect, useState } from "react";
import { collabApi } from "./api";

type Account = { mfa: { enabled: boolean; required: boolean } };
type Project = { id: string; organization_id: string; role: string };
export function GettingStarted({ project, organizations, onCreateProject }: {
 project?: Project; organizations: { id: string; name: string; role: string }[]; onCreateProject: () => void;
}) {
 const [status, setStatus] = useState<{ account: Account; repositories: number; models: number } | null>(null);
 const [error, setError] = useState("");
 const [generation, setGeneration] = useState(0);
 const projectId = project?.id;
 const refresh = useCallback(() => setGeneration(value => value + 1), []);
 useEffect(() => {
  const abort = new AbortController();
  void Promise.all([
   collabApi<Account>("me", undefined, undefined, abort.signal),
   projectId ? collabApi<{ repositories: unknown[] }>(`projects/${projectId}/repositories`, undefined, undefined, abort.signal) : Promise.resolve({ repositories: [] }),
   projectId ? collabApi<{ models: { enabled: boolean }[] }>(`projects/${projectId}/models`, undefined, undefined, abort.signal) : Promise.resolve({ models: [] }),
  ]).then(([account, repos, models]) => {
   if (!abort.signal.aborted) { setStatus({ account, repositories: repos.repositories.length, models: models.models.filter(m => m.enabled).length }); setError(""); }
  }).catch(e => { if (!abort.signal.aborted) { setStatus(null); setError(e.message); } });
  return () => abort.abort();
 }, [projectId, generation]);
 const organization = organizations.find(o => o.id === project?.organization_id) ?? (!project ? organizations.find(o => ["owner", "admin"].includes(o.role)) : undefined);
 const admin = organization && ["owner", "admin"].includes(organization.role);
 if (!status) return error ? <section aria-label="开始使用"><p role="alert">{error}</p><button className="collab-button" onClick={refresh}>重新检查</button></section> : null;
 const mfaPending = status.account.mfa.required && !status.account.mfa.enabled;
 if (!mfaPending && project && status.repositories > 0 && status.models > 0) return null;
 return <section className="collab-settings-section" aria-label="开始使用">
  <div className="collab-section-heading"><h2>开始使用</h2><button className="collab-text-button" onClick={refresh}>重新检查</button></div>
  <ol>
   {!project && <li>{admin ? <button className="collab-text-button" onClick={onCreateProject}>创建第一个项目</button> : "请团队管理员将你加入项目。"}</li>}
   {project && !status.repositories && <li>在新建项目时填写工作目录，或用左侧「打开文件夹」导入本机代码，即可直接开始编辑和对话。</li>}
   {project && !status.models && <li>需要配置 AI 模型才能开始对话。{project.role === "maintainer" ? "请在团队管理中启用模型，或联系部署管理员。" : "请联系项目维护者启用模型。"}</li>}
  </ol>
  {project && <p className="collab-muted">准备好后，直接在任务中与 AI 对话，让它帮你改代码。</p>}
 </section>;
}
