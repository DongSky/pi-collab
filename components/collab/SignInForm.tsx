"use client";
import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { collabApi } from "./api";
import type { OidcProvider } from "@/lib/collab/oidc";

export function SignInForm() {
  const router = useRouter();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [secondFactor, setSecondFactor] = useState(false);
  const [recovery, setRecovery] = useState(false);
  const [providers,setProviders]=useState<OidcProvider[]>([]);
  useEffect(()=>{const params=new URLSearchParams(location.search);if(params.has("oidcMfa"))setSecondFactor(true);if(params.has("oidcError")||params.has("error"))setError("组织登录未完成。请先用本地账户登录并绑定组织身份，或检查提供方和成员状态。");void collabApi<{providers:OidcProvider[]}>("oidc/providers").then(v=>setProviders(v.providers)).catch(()=>{});},[]);
  async function oidc(id:string){setBusy(true);setError("");try{const r=await collabApi<{url:string}>("auth/sign-in/social",{provider:`oidc-${id}`,callbackURL:location.origin+"/",errorCallbackURL:location.origin+"/sign-in?oidcError=1",disableRedirect:true});location.assign(r.url);}catch(e){setError(e instanceof Error?e.message:"组织登录失败");setBusy(false);}}
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    const fields = new FormData(event.currentTarget);
    try {
      const response = await fetch(`/api/collab/auth/${secondFactor ? recovery ? "two-factor/verify-backup-code" : "two-factor/verify-totp" : "sign-in/email"}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(secondFactor ? { code: fields.get("code") } : { email: fields.get("email"), password: fields.get("password") }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(response.status === 429 ? "尝试次数过多，请稍后重试。" : "登录失败，请检查账户信息。");
      if (result.twoFactorRedirect) setSecondFactor(true);
      else {
        const next = new URLSearchParams(location.search).get("next");
        // The lifecycle return path is deliberately restricted to a local
        // organization page; never turn a login link into an open redirect.
        router.replace(next && /^\/organizations\/[0-9a-f-]{36}$/.test(next) ? next : "/"); router.refresh();
      }
    } catch (error) { setError(error instanceof Error ? error.message : "暂时无法连接服务。"); }
    finally { setBusy(false); }
  }
  return <main className="collab-login">
    <section className="collab-login-intro">
      <div className="collab-wordmark">pi<span>:</span>collab</div>
      <p className="collab-eyebrow">共同开发，各自推进</p>
      <h1>让每个人的 AI，<br />为同一个项目工作。</h1>
      <p>独立任务与工作区，明确的依赖关系。<br />从并行开发到共同评审，保留每一步的来由。</p>
      <div className="collab-login-footer">Derived from pi-web · pi-collab</div>
    </section>
    <section className="collab-login-form-section">
      <form onSubmit={submit} method="post" action="/sign-in" className="collab-form">
        <h2>{secondFactor ? "验证身份" : "登录工作空间"}</h2>
        <p className="collab-muted">{secondFactor ? recovery ? "输入一个尚未使用的恢复码。" : "输入验证器中的 6 位动态验证码。" : "使用团队邀请的账户继续。"}</p>
        {secondFactor ? <label>{recovery ? "恢复码" : "验证码"}<input key={recovery ? "recovery" : "totp"} name="code" inputMode={recovery ? "text" : "numeric"} autoComplete="one-time-code" pattern={recovery ? undefined : "[0-9]{6}"} required autoFocus /></label> : <>
          <label>邮箱<input name="email" type="email" autoComplete="username" required autoFocus placeholder="you@example.com" /></label>
          <label>密码<input name="password" type="password" autoComplete="current-password" required /></label>
        </>}
        {error && <p className="collab-error" role="alert">{error}</p>}
        <button className="collab-button primary" type="submit" disabled={busy}>{busy ? "正在验证…" : secondFactor ? "验证并继续" : "登录"}<span aria-hidden="true">→</span></button>
        {secondFactor ? <button className="collab-text-button" type="button" onClick={() => setRecovery(value => !value)}>{recovery ? "使用验证器" : "使用恢复码"}</button> : <Link href="/forgot-password" className="collab-text-button">忘记密码</Link>}
        {!secondFactor&&providers.map(p=><button key={p.id} type="button" className="collab-button" disabled={busy} onClick={()=>void oidc(p.id)}>使用 {p.organizationName} · {p.name} 登录</button>)}
        <Link href="/account-recovery" className="collab-text-button">验证器和恢复码均已丢失</Link>
        <p className="collab-muted collab-small">还没有账户？请联系团队管理员。开发演示账户由本机初始化命令创建。</p>
      </form>
    </section>
  </main>;
}
