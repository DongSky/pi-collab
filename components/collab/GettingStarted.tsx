"use client";
import Link from "next/link";
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
 if (!status) return error ? <section aria-label="开始协作"><p role="alert">{error}</p><button className="collab-button" onClick={refresh}>重新检查开工条件</button></section> : null;
 const mfaPending = status.account.mfa.required && !status.account.mfa.enabled;
 if (!mfaPending && project && status.repositories > 0 && status.models > 0) return null;
 return <section className="collab-settings-section" aria-label="开始协作">
  <div className="collab-section-heading"><h2>开始协作</h2><button className="collab-text-button" onClick={refresh}>重新检查开工条件</button></div>
  <ol>
   {mfaPending && <li><Link href="/account">先设置账户安全</Link>：所有者与管理员启用验证器后，才能邀请成员和配置受保护资源。</li>}
   {!project && <li>{admin ? <button className="collab-text-button" onClick={onCreateProject}>创建第一个项目</button> : "请团队管理员将你加入项目；加入团队不会自动获得项目权限。"}</li>}
   {project && !status.repositories && <li>可先用左侧“打开文件夹”导入本机代码并直接开始编辑；也可连接现有 Git 仓库。{project.role === "maintainer" ? <>请部署管理员导入本机 Git 仓库，或登记 GitHub／GitLab 后导入。<details><summary>仓库接入说明</summary><p>本机导入使用 <code>npm run repo:import -- --project 项目编号 --actor 维护者邮箱 --source 仓库绝对路径 --name 仓库名称</code>；远程仓库登记后可在任务中的导入面板操作。</p><p>当前项目编号：<code>{project.id}</code></p></details></> : "请项目维护者完成仓库接入。"}</li>}
   {project && !status.models && <li>配置项目模型。{project.role === "maintainer" ? <>请部署管理员用 <code>npm run model:import</code> 显式导入本机 Pi 的一个模型，或在团队管理中启用已接入的模型。<p className="collab-muted">命令格式：npm run model:import -- --from-pi --project 项目编号 --actor 维护者邮箱 --provider Provider名称 --model 模型ID。支持的模型接口为 OpenAI Responses。密钥留在服务器，导入后由项目成员共享额度。</p></> : "请项目维护者启用一个可用模型。"}</li>}
   {admin && <li><Link href={`/organizations/${organization.id}`}>邀请协作者并分配项目角色</Link>；每位成员的 AI 使用独立工作区。</li>}
  </ol>
  {project && <p className="collab-muted">仓库与模型准备后，创建任务、填写目标及验收标准，再启动 AI。配置完成后点击“重新检查开工条件”。</p>}
 </section>;
}
