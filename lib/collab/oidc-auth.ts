import {betterAuth} from "better-auth";
import {genericOAuth} from "better-auth/plugins/generic-oauth";
import {decodeJwt} from "jose";
import {auth,authOptions} from "./auth";
import {database} from "./database";
import {oidcRuntime,openOidcSecret} from "./oidc";
import {DomainError} from "./policy";
export async function requestAuth(request:Request){
 const path=new URL(request.url).pathname.replace(/^\/api\/collab\/auth/,"");
 let name=path.startsWith("/callback/")?path.slice(10):undefined;
 if(["/sign-in/social","/link-social"].includes(path)){const body=await request.clone().json();name=body.provider;}
 if(!name?.startsWith("oidc-"))return auth();
 const id=name.slice(5);if(!/^[0-9a-f-]{36}$/.test(id))throw new DomainError("oidc_unavailable","组织登录不可用。",400);
 const p=await oidcRuntime(id);if(!p)throw new DomainError("oidc_unavailable","组织登录已停用或不存在。",403);
 const options=authOptions(database(),false,[{id:p.id,version:p.version}]);
 // Discovery is the reviewed, immutable endpoint set; secret never enters public metadata.
 return betterAuth({...options,plugins:[...options.plugins??[],genericOAuth({config:[{
  providerId:`oidc-${p.id}`,name:p.name,clientId:p.client_id,clientSecret:openOidcSecret(p),
  discoveryUrl:`${process.env.BETTER_AUTH_URL??"http://127.0.0.1:30142"}/api/collab/oidc/providers/${p.id}/discovery`,
  requireIdTokenVerification:true,pkce:true,scopes:["openid","profile","email"],disableSignUp:true,disableImplicitSignUp:true,disableProviderLogout:true,
  getUserInfo:async tokens=>{if(!tokens.idToken)return null;const claims=decodeJwt(tokens.idToken);if(typeof claims.sub!=="string"||typeof claims.email!=="string"||claims.email_verified!==true)return null;return{...claims,emailVerified:true,name:typeof claims.name==="string"?claims.name:claims.email};},
 }]})]});
}
export async function oidcAuthHandler(request:Request){
 try{return await(await requestAuth(request)).handler(request);}
 catch(e){if(new URL(request.url).pathname.includes("/callback/"))return Response.redirect(new URL("/sign-in?oidcError=1",process.env.BETTER_AUTH_URL??"http://127.0.0.1:30142"));return Response.json({error:"oidc_unavailable",message:e instanceof DomainError?e.message:"组织登录暂时不可用。"},{status:503});}
}
