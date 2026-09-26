import {createHash} from "node:crypto";
import {twoFactor} from "better-auth/plugins";
import {createAuthMiddleware,APIError} from "better-auth/api";
import type {BetterAuthOptions} from "better-auth";
import type {Pool} from "pg";
const digest=(v:string)=>createHash("sha256").update(v).digest("hex");
const cookies=(header:string|null)=>new Map((header??"").split(";").map(part=>{const i=part.indexOf("=");return[part.slice(0,i).trim(),part.slice(i+1)];}));
export type OidcPin={id:string;version:number};
export function oidcHooks(pool:Pool,pins:OidcPin[]=[]){
 const provider=(id:string|undefined)=>pins.find(p=>`oidc-${p.id}`===id);
 const callback=(path:string,id?:unknown)=>provider(path.startsWith("/callback/")?(typeof id==="string"?id:path.slice(10)):undefined);
 const denied=()=>new APIError("FORBIDDEN",{code:"OIDC_UNAVAILABLE",message:"组织登录不可用，请检查绑定和成员权限。"});
 const factor=twoFactor({issuer:"pi-collab"});const original=factor.hooks.after[0];
 const plugin={...factor,hooks:{...factor.hooks,after:[{matcher:(ctx:Parameters<typeof original.matcher>[0])=>original.matcher(ctx)||!!callback(ctx.path??"",ctx.params?.id),handler:createAuthMiddleware(async ctx=>{
  const pin=callback(ctx.path??"",ctx.params?.id),created=ctx.context.newSession;
  const result=await original.handler({...ctx,returnHeaders:true}) as unknown as {headers:Headers;response:Awaited<ReturnType<typeof original.handler>>};
  // Nested Better Call middleware owns a separate header collection and wraps
  // its return value. Forward both; otherwise password MFA loses its cookies.
  const responseHeaders=(ctx as unknown as {responseHeaders:Headers}).responseHeaders;
  for(const [name,value] of result.headers)if(name!=="set-cookie")responseHeaders.set(name,value);
  for(const value of result.headers.getSetCookie())responseHeaders.append("set-cookie",value);
  if(pin&&created?.user.twoFactorEnabled&&!ctx.context.newSession){
   const name=ctx.context.createAuthCookie("two_factor").name;
   const headers=[result.headers];
   const raw=headers.flatMap(h=>h?.getSetCookie()??[]).find(value=>value.startsWith(`${name}=`))?.split(";")[0].slice(name.length+1);
   if(!raw)throw denied();const hash=digest(raw);
   await pool.query("SELECT collab.record_oidc_pending($1,$2,$3,$4)",[hash,created.user.id,pin.id,pin.version]);
   const marker=ctx.context.createAuthCookie("oidc_mfa",{maxAge:600});ctx.setCookie(marker.name,hash,marker.attributes);
   return ctx.redirect(`${process.env.BETTER_AUTH_URL??"http://127.0.0.1:30142"}/sign-in?oidcMfa=1`);
  }
  return result.response;
 })}]}};
 const databaseHooks:BetterAuthOptions["databaseHooks"]={
  session:{create:{before:async(session,ctx)=>{
   const pin=callback(ctx?.path??"",ctx?.params?.id);if(pin)return{data:{...session,oidcProviderId:pin.id,oidcProviderVersion:String(pin.version)}};
   if(ctx?.path?.startsWith("/two-factor/verify")){
    const map=cookies(ctx.headers?.get("cookie")??null),marker=map.get(ctx.context.createAuthCookie("oidc_mfa").name);
    const raw=map.get(ctx.context.createAuthCookie("two_factor").name),hash=raw?digest(raw):undefined;
    if(marker&&hash!==marker)throw denied();
    // Resolve the proof from the signed 2FA cookie itself. Removing our UI marker
    // must not turn an OIDC challenge into an unscoped password session.
    const proof=hash?(await pool.query("SELECT collab.oidc_pending_context($1,$2) AS proof",[hash,session.userId])).rows[0].proof:null;
    if(marker&&!proof)throw denied();
    if(proof)return{data:{...session,oidcProviderId:proof.providerId,oidcProviderVersion:proof.version,oidcChallengeHash:hash}};
   }
  }}},
  account:{create:{before:async(account)=>account.providerId.startsWith("oidc-")?{data:{...account,accessToken:null,refreshToken:null,idToken:null}}:undefined},update:{before:async(account,ctx)=>callback(ctx?.path??"",ctx?.params?.id)?{data:{...account,accessToken:null,refreshToken:null,idToken:null}}:undefined}},
 };
 const user:BetterAuthOptions["user"]={validateUserInfo:async({user,source})=>{
  const pin=provider(source.oauth?.providerId);if(!pin)return;
  if(!user.id||user.emailVerified!==true||!(await pool.query("SELECT collab.oidc_authorized($1,$2,$3) AS allowed",[pin.id,user.id,pin.version])).rows[0].allowed)return{error:"oidc_membership_required",errorDescription:"先接受团队邀请并显式绑定已验证的同邮箱身份。"};
 }};
 return{plugin,databaseHooks,user};
}
