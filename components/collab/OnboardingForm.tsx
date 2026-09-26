"use client";
import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { collabApi } from "./api";

type Invitation = { email: string; organizationName: string; role: string; projectName: string | null; projectRole: string | null };
export function OnboardingForm({ mode }: { mode: "setup" | "invite" }) {
  const [token, setToken] = useState("");
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [user, setUser] = useState<{ email: string } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (mode !== "invite") return;
    const value = window.location.hash.slice(1);
    setToken(value);
    void collabApi<Invitation>("invitations/preview", { token: value }).then(setInvitation).catch(e => setError(e.message));
    void collabApi<{ user: { email: string } }>("me").then(result => setUser(result.user)).catch(() => {});
  }, [mode]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    const fields = new FormData(event.currentTarget);
    try {
      if (mode === "setup") await collabApi("setup", Object.fromEntries(fields));
      else await collabApi("invitations/accept", {
        token, email: invitation?.email,
        ...(!user ? { name: fields.get("name"), password: fields.get("password") } : {}),
      });
      setDone(true);
      if (mode === "invite") window.history.replaceState(null, "", "/invite");
    } catch (e) { setError(e instanceof Error ? e.message : "操作失败"); }
    finally { setBusy(false); }
  }
  return <main className="collab-app collab-settings"><div className="collab-settings-content">
    <Link href="/" className="collab-wordmark">pi:collab</Link>
    <h1>{mode === "setup" ? "初始化工作空间" : "加入团队"}</h1>
    {done ? <section role="status"><h2>{mode === "setup" ? "工作空间已创建" : "已加入团队"}</h2><p>所有者和管理员请在账户安全中启用多因素验证，然后邀请其他成员。</p><Link className="collab-button primary" href={user ? "/" : "/sign-in"}>继续</Link></section> : <form className="collab-form" onSubmit={submit}>
      {mode === "setup" ? <><p className="collab-muted">首次安装：创建团队及首位所有者。完成后此入口将关闭。</p><details><summary>如何取得初始化令牌</summary><p>请部署管理员在服务器的数据目录打开 <code>config.json</code>，只复制 <code>bootstrapToken</code> 字段。默认位置为项目下的 <code>.local/config.json</code>；自定义数据目录请查看启动终端中的 data 路径。不要分享整份配置。</p></details><label>初始化令牌<input name="token" type="password" required autoComplete="off" /></label><label>团队名称<input name="organizationName" required maxLength={120} /></label></> : invitation && <><p>邀请加入 <strong>{invitation.organizationName}</strong>{invitation.projectName ? ` · ${invitation.projectName}` : ""}</p><p className="collab-muted">受邀邮箱：{invitation.email} · {invitation.role === "admin" ? "管理员" : "成员"}</p>{user ? <p>当前登录：{user.email}</p> : <p className="collab-muted">已有此邮箱的账户？<Link href="/sign-in">先登录</Link>，再重新打开邀请链接。</p>}</>}
      {(mode === "setup" || (invitation && !user)) && <><label>姓名<input name="name" required autoComplete="name" maxLength={120} /></label>{mode === "setup" && <label>邮箱<input name="email" type="email" required autoComplete="username" /></label>}<label>新账户密码<input name="password" type="password" required minLength={12} maxLength={128} autoComplete="new-password" /></label></>}
      {error && <p className="collab-error" role="alert">{error}</p>}
      <button className="collab-button primary" disabled={busy || (mode === "invite" && !invitation)}>{busy ? "正在处理…" : mode === "setup" ? "创建工作空间" : "接受邀请"}</button>
    </form>}
  </div></main>;
}
