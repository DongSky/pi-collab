"use client";
import {useCallback,useEffect,useState,type FormEvent} from "react";
import {useRouter} from "next/navigation";
import {collabApi} from "./api";
import type {OidcBinding,OidcProvider} from "@/lib/collab/oidc";
export function OidcSettings({organizationId}:{organizationId:string}){
 const[providers,setProviders]=useState<OidcProvider[]>([]),[error,setError]=useState(""),[busy,setBusy]=useState(false),[reason,setReason]=useState(""),[secrets,setSecrets]=useState<Record<string,string>>({});
 const refresh=useCallback(async()=>setProviders((await collabApi<{providers:OidcProvider[]}>(`organizations/${organizationId}/oidc`)).providers),[organizationId]);
 useEffect(()=>{void refresh().catch(e=>setError(e.message));},[refresh]);
 async function send(body:unknown){setBusy(true);setError("");try{await collabApi(`organizations/${organizationId}/oidc`,body);await refresh();setSecrets({});setReason("");}catch(e){setError(e instanceof Error?e.message:"操作失败");}finally{setBusy(false);}}
 async function create(event:FormEvent<HTMLFormElement>){event.preventDefault();const form=event.currentTarget,fields=new FormData(form);await send({action:"create",name:fields.get("name"),issuer:fields.get("issuer"),clientId:fields.get("clientId"),clientSecret:fields.get("secret"),reason:fields.get("reason")});form.reset();}
 return <section className="collab-settings-section" aria-label="组织 OIDC 登录"><h2>组织 OIDC 登录</h2><p className="collab-muted">邀请成员后，由成员在账户安全页绑定同邮箱的已验证身份。组织登录保留本地 MFA，不自动添加成员或项目权限。</p>{error&&<p className="collab-error" role="alert">{error}</p>}
 <details><summary>添加身份提供方</summary><form className="collab-form" onSubmit={create}><label>提供方名称<input name="name" required maxLength={100}/></label><label>Issuer URL<input name="issuer" type="url" required placeholder="https://login.example.com/realms/team"/></label><label>Client ID<input name="clientId" required/></label><label>Client Secret<input name="secret" type="password" required autoComplete="new-password"/></label><label>添加原因<textarea name="reason" minLength={10} maxLength={2000} required/></label><button className="collab-button" disabled={busy}>验证发现文档并添加</button></form></details>
 <p className="collab-small">注册后将下方回调地址加入提供方的允许列表。首版要求授权码、PKCE S256、签名 ID Token 与同源端点；Issuer 和 Client ID 固定，变更时新增提供方。</p>
 {providers.map(p=><article key={p.id}><h3>{p.name} · {p.enabled?"启用":"停用"}</h3><p className="collab-small">{p.issuer} · Client ID {p.clientId} · v{p.version}</p><label className="collab-form">回调地址<input aria-label={`${p.name} 回调地址`} readOnly value={typeof window==="undefined"?"":`${window.location.origin}/api/collab/auth/callback/oidc-${p.id}`}/></label><div className="collab-form compact"><label>轮换 Client Secret<input aria-label={`${p.name} 新 Client Secret`} type="password" autoComplete="new-password" value={secrets[p.id]??""} onChange={e=>setSecrets({...secrets,[p.id]:e.target.value})}/></label><button className="collab-button" disabled={busy||!secrets[p.id]||reason.trim().length<10} onClick={()=>void send({action:"rotate",id:p.id,expectedVersion:p.version,clientSecret:secrets[p.id],reason})}>轮换密钥并撤销会话</button><button className="collab-button" disabled={busy||reason.trim().length<10} onClick={()=>void send({action:"toggle",id:p.id,expectedVersion:p.version,enabled:!p.enabled,reason})}>{p.enabled?"停用提供方并撤销会话":"重新启用提供方"}</button></div></article>)}
 {providers.length>0&&<label className="collab-form">OIDC 变更原因<textarea aria-label="OIDC 变更原因" value={reason} onChange={e=>setReason(e.target.value)} minLength={10} maxLength={2000}/><span className="collab-small">提供方变更将撤销所有已绑定成员的登录会话和待完成的二次验证；本地密码与成员角色保留。</span></label>}
 </section>;
}
export function OidcBindings(){
 const router=useRouter();
 const[data,setData]=useState<OidcBinding[]>([]),[error,setError]=useState(""),[busy,setBusy]=useState(false);
 useEffect(()=>{void collabApi<{bindings:OidcBinding[]}>("oidc/bindings").then(v=>setData(v.bindings)).catch(e=>setError(e.message));},[]);
 async function bind(id:string){setBusy(true);setError("");try{const r=await collabApi<{url:string}>("auth/link-social",{provider:`oidc-${id}`,callbackURL:`${location.origin}/account`,errorCallbackURL:`${location.origin}/account?oidcError=1`,disableRedirect:true});location.assign(r.url);}catch(e){setError(e instanceof Error?e.message:"绑定失败");setBusy(false);}}
 async function revoke(id:string){setBusy(true);setError("");try{await collabApi(`oidc/bindings/${id}`,undefined,"DELETE");router.replace("/sign-in");router.refresh();}catch(e){setError(e instanceof Error?e.message:"解除失败");setBusy(false);}}
 useEffect(()=>{if(new URLSearchParams(location.search).has("oidcError"))setError("绑定失败，请检查提供方中的已验证邮箱是否与本地账户一致，以及团队成员资格。");},[]);
 return <section className="collab-settings-section" aria-label="组织身份绑定"><h2>组织身份绑定</h2><p className="collab-muted">绑定前请在 10 分钟内重新登录。解除绑定会退出所有本地会话，仍可用本地密码登录。</p>{error&&<p role="alert" className="collab-error">{error}</p>}{!data.length&&<p>所在团队尚未配置组织登录。</p>}{data.map(p=><div className="collab-session" key={p.id}><div><strong>{p.organizationName} · {p.name}</strong><small>{p.bound?"已绑定":"未绑定"} · {p.enabled?"可用":"已停用"}</small></div>{p.bound?<button className="collab-button" disabled={busy} onClick={()=>void revoke(p.id)}>解除绑定并退出登录</button>:<button className="collab-button" disabled={busy||!p.enabled} onClick={()=>void bind(p.id)}>绑定组织身份</button>}</div>)}</section>;
}
