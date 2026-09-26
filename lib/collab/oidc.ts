import {createHash,randomUUID} from "node:crypto";
import {z} from "zod";
import {database,asUser} from "./database";
import {DomainError} from "./policy";
import {sealCredential,openCredential,validateEndpoint} from "./gateway/credentials";
export const oidcCommand=z.discriminatedUnion("action",[
 z.object({action:z.literal("create"),name:z.string().trim().min(1).max(100),issuer:z.string().url(),clientId:z.string().trim().min(1).max(500),clientSecret:z.string().min(1).max(16000),reason:z.string().trim().min(10).max(2000)}).strict(),
 z.object({action:z.literal("toggle"),id:z.uuid(),expectedVersion:z.number().int().positive(),enabled:z.boolean(),reason:z.string().trim().min(10).max(2000)}).strict(),
 z.object({action:z.literal("rotate"),id:z.uuid(),expectedVersion:z.number().int().positive(),clientSecret:z.string().min(1).max(16000),reason:z.string().trim().min(10).max(2000)}).strict(),
]);
export type OidcProvider={id:string;organizationId:string;organizationName:string;name:string;issuer:string;clientId:string;enabled:boolean;version:number};
export type OidcBinding={id:string;name:string;organizationName:string;enabled:boolean;bound:boolean;boundAt:string|null};
export type RuntimeProvider={id:string;organization_id:string;name:string;issuer:string;client_id:string;secret:unknown;metadata:Record<string,unknown>;version:number};
const key=()=>{if(!process.env.BETTER_AUTH_SECRET||process.env.BETTER_AUTH_SECRET.length<32)throw new Error("Persistent authentication secret required");return createHash("sha256").update(`pi-collab:oidc:v1:${process.env.BETTER_AUTH_SECRET}`).digest();};
export const openOidcSecret=(provider:RuntimeProvider)=>openCredential(key(),provider.id,provider.organization_id,provider.secret).apiKey;
export async function oidcProviders():Promise<OidcProvider[]>{return(await database().query("SELECT collab.oidc_list(NULL) AS value")).rows[0].value;}
export async function oidcRuntime(id:string):Promise<RuntimeProvider|null>{z.uuid().parse(id);return(await database().query("SELECT collab.oidc_runtime($1) AS value",[id])).rows[0].value;}
export function organizationOidc(user:string,org:string):Promise<OidcProvider[]>{z.uuid().parse(org);return asUser(user,async db=>(await db.query("SELECT collab.oidc_list($1) AS value",[org])).rows[0].value);}
export function oidcBindings(user:string):Promise<OidcBinding[]>{return asUser(user,async db=>(await db.query("SELECT collab.oidc_bindings() AS value")).rows[0].value);}
export function revokeOidcBinding(user:string,id:string){z.uuid().parse(id);return asUser(user,async db=>{await db.query("SELECT collab.revoke_oidc_binding($1)",[id]);return{signInRequired:true};});}
export async function discoverOidc(raw:string){
 const issuer=validateEndpoint(raw),response=await fetch(`${issuer}/.well-known/openid-configuration`,{redirect:"error",signal:AbortSignal.timeout(6000),headers:{Accept:"application/json"}});
 if(!response.ok||!response.body)throw new DomainError("oidc_discovery_failed","无法读取 OIDC 配置。",400);
 const reader=response.body.getReader();let bytes=0;const chunks:Uint8Array[]=[];try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>65536)throw new Error("OIDC metadata too large");chunks.push(value);}}finally{await reader.cancel();}
 const d=JSON.parse(Buffer.concat(chunks).toString("utf8"));
 if(d.issuer!==issuer)throw new DomainError("oidc_issuer_mismatch","发现文档的 issuer 与配置不一致。",400);
 const metadata:Record<string,unknown>={issuer};
 for(const field of ["authorization_endpoint","token_endpoint","jwks_uri"]){const endpoint=validateEndpoint(z.string().url().parse(d[field]));if(new URL(endpoint).origin!==new URL(issuer).origin)throw new DomainError("oidc_endpoint_mismatch","首版要求授权、令牌和 JWKS 端点与 issuer 同源。",400);metadata[field]=endpoint;}
 const algorithms=z.array(z.string()).parse(d.id_token_signing_alg_values_supported).filter(x=>["RS256","RS384","RS512","ES256","ES384","ES512","PS256","PS384","PS512","EdDSA"].includes(x));
 if(!algorithms.length||!Array.isArray(d.response_types_supported)||!d.response_types_supported.includes("code")||d.code_challenge_methods_supported&&!d.code_challenge_methods_supported.includes("S256"))throw new DomainError("oidc_unsupported","需要授权码、PKCE S256 和非对称签名 ID Token。",400);
 metadata.id_token_signing_alg_values_supported=algorithms;metadata.response_types_supported=["code"];return{issuer,metadata};
}
export async function configureOidc(user:string,org:string,raw:unknown){
 z.uuid().parse(org);const input=oidcCommand.parse(raw);
 await organizationOidc(user,org); // Check management authority before any outbound discovery request.
 const id=input.action==="create"?randomUUID():input.id;
 let payload:Record<string,unknown>;
 if(input.action==="create"){const discovered=await discoverOidc(input.issuer);const {clientSecret,...rest}=input;payload={...rest,...discovered,secret:sealCredential(key(),id,org,{apiKey:clientSecret,baseUrl:discovered.issuer})};}
 else if(input.action==="rotate"){const existing=(await organizationOidc(user,org)).find(p=>p.id===id);if(!existing)throw new DomainError("not_found","提供方不存在。",404);const{clientSecret,...rest}=input;payload={...rest,secret:sealCredential(key(),id,org,{apiKey:clientSecret,baseUrl:existing.issuer})};}
 else payload=input;
 return asUser(user,async db=>({id:(await db.query("SELECT collab.configure_oidc($1,$2,$3) AS id",[org,id,payload])).rows[0].id as string}));
}
