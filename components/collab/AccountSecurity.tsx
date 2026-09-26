"use client";
import Link from "next/link";
import { OidcBindings } from "./OidcSettings";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { collabApi } from "./api";

type Me = { user: { id: string; email: string }; mfa: { enabled: boolean; required: boolean } };
type Session = { id: string; token: string; userAgent?: string; createdAt: string };
export function AccountSecurity() {
  const [me, setMe] = useState<Me | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [enrollment, setEnrollment] = useState<{ totpURI: string; backupCodes: string[] } | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    const [account, active] = await Promise.all([collabApi<Me>("me"), collabApi<Session[]>("auth/list-sessions")]);
    setMe(account); setSessions(active);
  }, []);
  useEffect(() => { void refresh().catch(e => setError(e.message)); }, [refresh]);
  async function mfa(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); setNotice("");
    const fields = new FormData(event.currentTarget);
    try {
      if (enrollment && !me?.mfa.enabled) {
        await collabApi("auth/two-factor/verify-totp", { code: fields.get("code") });
        setNotice("多因素验证已启用。请离线保存恢复码；旧会话已撤销。"); await refresh();
      } else {
        setEnrollment(await collabApi("auth/two-factor/enable", { password: fields.get("password") }));
      }
    } catch (e) { setError(e instanceof Error ? e.message : "操作失败"); }
    finally { setBusy(false); }
  }
  async function revoke(session: Session) {
    setBusy(true); setError("");
    try { await collabApi("auth/revoke-session", { token: session.token }); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : "操作失败"); }
    finally { setBusy(false); }
  }
  async function disableMfa(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); setNotice("");
    const fields = new FormData(event.currentTarget);
    try {
      await collabApi("auth/two-factor/disable", { password: fields.get("password") });
      setEnrollment(null); setNotice("已关闭多因素验证。"); await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "操作失败"); }
    finally { setBusy(false); }
  }
  return <main className="collab-app collab-settings"><div className="collab-settings-content"><Link href="/">← 返回项目</Link><h1>账户安全</h1><p className="collab-muted">{me?.user.email}</p>
    {error && <p role="alert" className="collab-error">{error} <Link href="/sign-in">登录</Link></p>}{notice && <p role="status">{notice}</p>}
    <section className="collab-settings-section"><h2>多因素验证</h2><p>{me?.mfa.enabled ? "已启用验证器和恢复码。" : "尚未启用。"}{me?.mfa.required && " 团队所有者和管理员必须启用后才能邀请和管理成员。"}</p>
      {!me?.mfa.enabled && <form className="collab-form" onSubmit={mfa}>{enrollment ? <><p>在验证器中添加账户，输入下面的设置密钥，然后填写 6 位验证码。</p><label>设置密钥<input readOnly value={new URL(enrollment.totpURI).searchParams.get("secret") ?? ""} autoComplete="off" /></label><label>验证码<input name="code" autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" required /></label></> : <label>当前密码<input name="password" type="password" autoComplete="current-password" required /></label>}<button className="collab-button primary" disabled={busy}>{enrollment ? "验证并启用" : "设置验证器"}</button></form>}
      {enrollment && <div className="collab-recovery"><h3>恢复码</h3><p>每个恢复码只能使用一次，请保存到安全的离线位置。</p><pre>{enrollment.backupCodes.join("\n")}</pre>{me?.mfa.enabled && <button className="collab-button" onClick={() => setEnrollment(null)}>已保存，隐藏恢复码</button>}</div>}
      {me?.mfa.enabled && !me.mfa.required && <form className="collab-form" onSubmit={disableMfa}><label>关闭验证前输入当前密码<input name="password" type="password" autoComplete="current-password" required /></label><button className="collab-button" disabled={busy}>关闭多因素验证</button></form>}
    </section>
    <OidcBindings/>
    <section className="collab-settings-section"><h2>登录会话</h2><p className="collab-muted">撤销当前会话会退出登录。</p>{sessions.map(session => <div className="collab-session" key={session.id}><div><strong>{session.userAgent || "浏览器会话"}</strong><small>{new Date(session.createdAt).toLocaleString()}</small></div><button className="collab-button" disabled={busy} onClick={() => void revoke(session)}>撤销会话</button></div>)}</section>
    <section className="collab-settings-section"><h2>密码</h2><Link href="/forgot-password">通过邮箱重置密码</Link></section>
  </div></main>;
}
