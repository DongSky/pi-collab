// Supervisor-owned JSONL protocol. Project stdout/stderr never become protocol
// frames. HTTP travels through this channel; no host/container port is published.
import {OutputRedactor} from './output-redaction.mjs';
import {StringDecoder} from 'node:string_decoder';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {createServer} from 'node:net';
import {request} from 'node:http';
import {readFile,lstat,writeFile} from 'node:fs/promises';
import path from 'node:path';
let service,started=false,closed=false,exitCode=null,lastHeartbeat=Date.now(),outputBytes=0,outputTail='',stopping=false;
const send=v=>process.stdout.write(JSON.stringify(v)+'\n');
const reply=(c,data)=>send({id:c.id,type:'response',command:c.type,success:true,data});
const port=Number(process.env.PORT),npm=process.env.PI_COLLAB_NPM_CLI;
function captureStream(stream){const decoder=new StringDecoder('utf8'),filter=new OutputRedactor();stream.on('data',data=>{outputBytes+=data.length;outputTail=(outputTail+filter.push(decoder.write(data))).slice(-16000);if(outputBytes>8*1024*1024)shutdown();});stream.on('end',()=>{outputTail=(outputTail+filter.push(decoder.end())+filter.finish()).slice(-16000);});}
function shutdown(){if(stopping)return;stopping=true;service?.kill('SIGTERM');
 // Native entry is a dedicated process/session leader. Container entry is not;
 // killing its runner makes the container bridge exit and the init reap children.
 if(process.env.PI_COLLAB_SERVICE_CONTAINER==='1'){setTimeout(()=>process.exit(0),500);return;}
 try{process.kill(-process.pid,'SIGTERM');}catch{}
 setTimeout(()=>{try{process.kill(-process.pid,'SIGKILL');}catch{process.exit(1);}},1500);
}
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);process.stdin.on('end',shutdown);
setInterval(()=>{if(Date.now()-lastHeartbeat>10000)shutdown();},1000);
function command(step){if(!['node','npm'].includes(step?.tool)||!Array.isArray(step.args)||!step.args.length||step.args.length>32||step.args.some(a=>typeof a!=='string'||a.length>1000||/[\x00-\x1f\x7f]/.test(a)))throw new Error('service_command_invalid');return step.tool==='node'?step.args:[npm,...step.args];}
function launch(step){const child=spawn(process.execPath,command(step),{cwd:process.cwd(),env:process.env,stdio:['ignore','pipe','pipe']});captureStream(child.stdout);captureStream(child.stderr);return child;}
async function runStep(step){const child=launch(step);let timer;try{await new Promise((resolve,reject)=>{timer=setTimeout(()=>{child.kill('SIGTERM');reject(new Error('service_build_timeout'));},step.timeoutSeconds*1000);child.once('error',()=>reject(new Error('service_spawn_failed')));child.once('exit',code=>code===0?resolve():reject(new Error('service_build_failed')));});}finally{clearTimeout(timer);}}
function http(input){return new Promise((resolve,reject)=>{
 if(!['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS'].includes(input.method)||typeof input.path!=='string'||!input.path.startsWith('/')||input.path.startsWith('//')||/[\x00-\x20\x7f\\]/.test(input.path)||input.path.length>4096)throw new Error('service_http_invalid');
 const body=Buffer.from(input.body??'','base64');if(body.length>1024*1024)throw new Error('service_http_limit');
 const req=request({hostname:'127.0.0.1',port,path:input.path,method:input.method,headers:{'content-type':String(input.contentType||'application/octet-stream').slice(0,200),'content-length':body.length,'connection':'close'},timeout:8000},res=>{
  const chunks=[];let count=0;res.on('data',chunk=>{count+=chunk.length;if(count>2*1024*1024){res.destroy();reject(new Error('service_response_limit'));}else chunks.push(chunk);});res.once('error',reject);res.once('end',()=>resolve({status:res.statusCode,contentType:res.headers['content-type']??'application/octet-stream',body:Buffer.concat(chunks).toString('base64'),...(res.headers.location?{location:res.headers.location}:{})}));
 });req.once('timeout',()=>req.destroy(new Error('service_http_timeout')));req.once('error',reject);req.end(body);
});}
const input=createInterface({input:process.stdin,crlfDelay:Infinity});
input.on('line',line=>{void(async()=>{let c;try{c=JSON.parse(line);
 if(c.type==='get_state')reply(c,{started,closed,exitCode,outputBytes,outputTail});
 else if(c.type==='service_heartbeat'){lastHeartbeat=Date.now();reply(c,{alive:!closed&&!stopping});}
 else if(c.type==='service_start'){
  if(started||stopping||!Number.isInteger(port)||port<61000||port>61999)throw new Error('service_start_invalid');started=true;
  await new Promise((resolve,reject)=>{const probe=createServer();probe.once('error',()=>reject(new Error('service_port_occupied')));probe.listen(port,'127.0.0.1',()=>probe.close(e=>e?reject(e):resolve()));});
  const config=c.config;if(!['none','npm-ci'].includes(config?.install))throw new Error('service_config_invalid');
  if(config.install==='npm-ci'){
   for(const name of ['package.json','package-lock.json']){const stat=await lstat(name);if(!stat.isFile()||stat.isSymbolicLink())throw new Error('service_lockfile_required');await readFile(name);}
   try{await lstat('.npmrc');throw new Error('service_project_npm_config');}catch(e){if(e.code!=='ENOENT')throw e;}
   await runStep({tool:'npm',args:['ci','--ignore-scripts','--no-audit','--no-fund'],timeoutSeconds:120});
  }
  if(config.build)for(const step of config.build.steps)await runStep(step);
  service=launch(config.start);service.once('error',()=>{closed=true;exitCode=-1;});service.once('exit',code=>{closed=true;exitCode=code;});
  const deadline=Date.now()+20000;let ready=false;
  while(!ready&&Date.now()<deadline&&!closed&&!stopping){try{const r=await http({method:'GET',path:config.healthPath,body:''});ready=r.status>=200&&r.status<400;}catch{}if(!ready)await new Promise(r=>setTimeout(r,200));}
  if(!ready)throw new Error('service_health_failed');reply(c,{ready:true});
 }else if(c.type==='service_http'){if(!service||closed||stopping)throw new Error('service_unavailable');reply(c,await http(c.request));}
 else throw new Error('service_command_invalid');
 }catch(e){send({id:c?.id,type:'response',command:c?.type,success:false,error:/^service_[a-z_]+$/.test(e?.message)?e.message:'service_operation_failed'});}})();});
// Separate empty npm configs keep host credentials and global settings out.
for(const name of ['service-user.npmrc','service-global.npmrc'])await writeFile(path.join(process.env.HOME,name),'',{flag:'wx',mode:0o600});
