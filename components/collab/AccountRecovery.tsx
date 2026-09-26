"use client";
import Link from "next/link";
import {useEffect,useState} from "react";
import {collabApi} from "./api";
export function AccountRecovery(){const [token,setToken]=useState(""),[done,setDone]=useState(false),[error,setError]=useState(""),[busy,setBusy]=useState(false);
 useEffect(()=>{const value=new URLSearchParams(location.hash.slice(1)).get("token");if(value){setToken(value);history.replaceState(null,"",location.pathname);}},[]);
 return <main className="collab-app collab-settings"><div className="collab-settings-content"><h1>账户应急恢复</h1>{done?<><p role="status">密码已重置，旧会话、验证器及恢复码已撤销。请重新登录并设置多因素验证。</p><Link href="/sign-in">重新登录</Link></>:<><p>丢失密码、验证器及恢复码时，请让本机部署管理员核验身份并签发一次性恢复凭证。组织管理员无法在网页中替你解除验证器。</p><form className="collab-form" onSubmit={async e=>{e.preventDefault();const f=new FormData(e.currentTarget);if(f.get("password")!==f.get("confirmation")){setError("两次密码不一致。");return;}setBusy(true);setError("");try{await collabApi("account-recovery",{token,password:f.get("password")});setToken("");setDone(true);}catch(e){setError(e instanceof Error?e.message:"恢复失败");}finally{setBusy(false);}}}>
 <label>一次性恢复凭证<input type="password" autoComplete="off" value={token} onChange={e=>setToken(e.target.value)} required pattern="[a-f0-9]{64}"/></label><label>新密码<input name="password" type="password" autoComplete="new-password" minLength={12} maxLength={128} required/></label><label>确认新密码<input name="confirmation" type="password" autoComplete="new-password" minLength={12} maxLength={128} required/></label><p>恢复后所有旧登录与模型授权失效，进行中的 AI 会请求停止。恢复不启用已停用的成员资格，也不改变任何角色。</p>{error&&<p role="alert">{error}</p>}<button className="collab-button" disabled={busy}>恢复账户</button></form><Link href="/sign-in">返回登录</Link></>}</div></main>;
}
