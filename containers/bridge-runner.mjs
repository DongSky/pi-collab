// Container-only entrypoint. Its loopback gateway uses the attached stdio channel;
// the container has --network=none and cannot open a connection to the host.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
const cli='/opt/pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js';
const npm='/usr/local/lib/node_modules/npm/bin/npm-cli.js';
const output=event=>process.stdout.write(JSON.stringify(event)+'\n');
const pending=new Map();
const server=createServer(async(req,res)=>{
 if(pending.size>=4){res.writeHead(429);res.end();return;}
 if(req.headers.origin||req.headers.cookie){res.writeHead(403);res.end();return;}
 const target=req.url==='/v1/responses'?'model':req.url==='/v1/coordinate'?'coordination':req.url?.startsWith('/registry/')?'registry':null;
 if(!target||(target==='registry'?req.method!=='GET':req.method!=='POST')){res.writeHead(404);res.end();return;}
 const chunks=[];let bytes=0;
 try{
  for await(const chunk of req){bytes+=chunk.length;if(bytes>16*1024*1024)throw new Error('body limit');chunks.push(chunk);}
  const id=randomUUID(),timer=setTimeout(()=>{output({type:'collab_bridge_cancel',id});res.destroy();pending.delete(id);},120000);
  pending.set(id,{res,timer,bytes:0});
  res.once('close',()=>{const p=pending.get(id);if(p){clearTimeout(p.timer);pending.delete(id);output({type:'collab_bridge_cancel',id});}});
  output({type:'collab_bridge_request',id,target,path:req.url,authorization:req.headers.authorization??'',body:Buffer.concat(chunks).toString('base64')});
 }catch{if(!res.destroyed){res.writeHead(413);res.end();}}
});
await new Promise(resolve=>server.listen(39871,'127.0.0.1',resolve));
const hash=async file=>createHash('sha256').update(await readFile(file)).digest('hex');
output({type:'collab_runtime',runtime:{node:process.version,nodeHash:await hash(process.execPath),npmHash:await hash(npm),piHash:await hash(cli),platform:process.platform,arch:process.arch,kernel:os.release(),backend:'docker'}});
const terminal=process.argv[2]==='--collab-terminal',preview=process.argv[2]==='--collab-preview';
const child=spawn(process.execPath,terminal?['/opt/pi/lib/collab/runtime/terminal-runner.mjs']:preview?['/opt/pi/lib/collab/runtime/service-runner.mjs']:[cli,...process.argv.slice(2)],{stdio:['pipe','pipe','pipe'],env:process.env});
// Keep each JSONL frame intact while multiplexing Pi output and gateway traffic.
const fromPi=createInterface({input:child.stdout,crlfDelay:Infinity});fromPi.on('line',line=>process.stdout.write(line+'\n'));
child.stderr.pipe(process.stderr);
const input=createInterface({input:process.stdin,crlfDelay:Infinity});
input.on('line',line=>{
 let event;try{event=JSON.parse(line);}catch{child.stdin.write(line+'\n');return;}
 if(event.type!=='collab_bridge_response'){child.stdin.write(line+'\n');return;}
 const p=pending.get(event.id);if(!p)return;
 if(event.status!==undefined&&!p.res.headersSent)p.res.writeHead(event.status,{'content-type':event.contentType??'application/octet-stream','cache-control':'no-store'});
 if(event.chunk){const chunk=Buffer.from(event.chunk,'base64');p.bytes+=chunk.length;if(p.bytes>128*1024*1024){p.res.destroy();return;}p.res.write(chunk);}
 if(event.end||event.error){clearTimeout(p.timer);pending.delete(event.id);if(event.error)p.res.destroy();else p.res.end();}
});
input.on('close',()=>child.kill('SIGTERM'));
const stop=()=>child.kill('SIGTERM');process.on('SIGTERM',stop);process.on('SIGINT',stop);
child.on('error',()=>{process.stderr.write('Container Pi launch failed\n');process.exit(1);});
child.on('close',code=>{for(const p of pending.values()){clearTimeout(p.timer);p.res.destroy();}server.close();input.close();process.exit(code??1);});
