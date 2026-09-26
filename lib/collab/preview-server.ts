import {servicePreviewHandler} from "./service-preview-server";
import {createHash} from 'node:crypto';
import type {IncomingMessage,ServerResponse} from 'node:http';
import type {Pool} from 'pg';
import {previewAsset,previewPath,removePreview} from './preview-artifacts';
export function previewHandler(pool:Pool,root:string,webOrigin:string){
 const dynamic=servicePreviewHandler(pool,webOrigin);
 const origin=new URL(webOrigin).origin,windows=new Map<string,{at:number;count:number}>();let active=0;
 return async(req:IncomingMessage,res:ServerResponse)=>{
  if(await dynamic(req,res))return true;
  if(!req.url?.startsWith('/preview/'))return false;
  const reply=(status:number,body:Buffer|string,type='text/plain; charset=utf-8')=>{res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Access-Control-Allow-Origin':'*','Cross-Origin-Resource-Policy':'cross-origin','Permissions-Policy':'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
   'Content-Security-Policy':`sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'; frame-ancestors ${origin}`});res.end(req.method==='HEAD'?undefined:body);};
  let counted=false;
  try{
   if(!['GET','HEAD'].includes(req.method??'')){reply(405,'Preview unavailable');return true;}
   const match=/^\/preview\/([a-f0-9]{64})\/([^?#]+)$/.exec(req.url);if(!match){reply(404,'Preview unavailable');return true;}
   const digest=createHash('sha256').update(match[1]).digest('hex'),file=previewPath.parse(decodeURIComponent(match[2]));
   const now=Date.now();for(const [key,value] of windows)if(now-value.at>60000)windows.delete(key);
   const w=windows.get(digest)??{at:now,count:0};if(active>=32||windows.size>=1000||++w.count>240){reply(429,'Preview rate limit');return true;}windows.set(digest,w);active++;counted=true;
   const access=async()=>(await pool.query('SELECT collab_gateway.preview_access($1) AS result',[digest])).rows[0].result;
   const p=await access();if(!p){reply(404,'Preview unavailable');return true;}
   const asset=await previewAsset(root,p.id,p.artifactHash,file);if(!await access()){reply(404,'Preview unavailable');return true;}
   await pool.query('SELECT collab_gateway.preview_log($1,$2,$3)',[digest,file,asset?200:404]);reply(asset?200:404,asset?.body??'Preview file unavailable',asset?.type);return true;
  }catch{if(!res.headersSent)reply(404,'Preview unavailable');else res.destroy();return true;}finally{if(counted)active--;}
 };
}
export async function sweepPreviews(pool:Pool,root:string){const ids=(await pool.query('SELECT collab_gateway.expired_previews() AS ids')).rows[0].ids as string[];for(const id of ids){await removePreview(root,id);await pool.query('SELECT collab_gateway.preview_cleaned($1)',[id]);}return ids.length;}
