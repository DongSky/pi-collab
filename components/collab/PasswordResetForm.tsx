"use client";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { collabApi } from "./api";

export function PasswordResetForm({ token }: { token?: string }) {
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    const fields = new FormData(event.currentTarget);
    try {
      if (token) await collabApi("auth/reset-password", { token, newPassword: fields.get("password") });
      else await collabApi("auth/request-password-reset", { email: fields.get("email"), redirectTo: `${location.origin}/reset-password` });
      setDone(true);
    } catch (e) { setError(e instanceof Error ? e.message : "操作失败"); }
    finally { setBusy(false); }
  }
  return <main className="collab-app collab-settings"><div className="collab-settings-content"><Link href="/sign-in">← 返回登录</Link><h1>重置密码</h1>
    {done ? <p role="status">{token ? "密码已重置，旧会话已撤销，请重新登录。" : "如果该邮箱对应现有账户，你将收到重置邮件。本机开发环境将邮件保存在私有 mailbox 目录。"}</p> : <form className="collab-form" onSubmit={submit}>
      {token ? <label>新密码<input name="password" type="password" autoComplete="new-password" minLength={12} maxLength={128} required /></label> : <label>账户邮箱<input name="email" type="email" autoComplete="username" required /></label>}
      {error && <p role="alert" className="collab-error">{error}</p>}<button className="collab-button primary" disabled={busy}>{token ? "保存新密码" : "获取重置链接"}</button>
    </form>}
  </div></main>;
}
