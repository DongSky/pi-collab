import test from "node:test";
import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {mkdtemp,mkdir,readFile,writeFile,rm} from "node:fs/promises";
import {createServer} from "node:http";
import {once} from "node:events";
import os from "node:os";
import path from "node:path";
import {randomUUID,randomBytes} from "node:crypto";
import {DockerRuntimeBackend,type AgentProcess} from "../../lib/collab/runtime/backends";
import {createWorkspace} from "../../lib/collab/runtime/workspace";
import {inspectContainerExit} from "../../lib/collab/runtime/container-receipts";
const exec=promisify(execFile),enabled=process.env.PI_COLLAB_TEST_DOCKER==="1";
test("two real container Pi processes isolate writes, bridge only authorized endpoints and confirm exit",{skip:!enabled,timeout:120000},async()=>{
 const root=await mkdtemp(path.join(process.env.PI_COLLAB_DOCKER_TEST_ROOT??os.tmpdir(),"collab-docker-")),repository=path.join(root,"source"),running:AgentProcess[]=[];
 const token=randomBytes(32).toString("hex");let calls=0;
 const server=createServer(async(req,res)=>{
  assert.equal(req.headers.authorization,`Bearer ${token}`);assert.equal(req.url,"/v1/coordinate");let body="";for await(const chunk of req)body+=chunk;
  const value=JSON.parse(body);calls++;res.setHeader("content-type","application/json");res.end(JSON.stringify(value.method==="ready"?{protocolVersion:1}:{fixture:true}));
 });server.listen(0,"127.0.0.1");await once(server,"listening");const url=`http://127.0.0.1:${(server.address() as {port:number}).port}/v1/coordinate`;
 try{
  await mkdir(repository);for(const args of [["init"],["config","user.name","Container fixture"],["config","user.email","fixture@test.invalid"]])await exec("git",args,{cwd:repository});
  await writeFile(path.join(repository,"shared.txt"),"base\n");await exec("git",["add","."],{cwd:repository});await exec("git",["commit","-m","fixture"],{cwd:repository});
  const workspaces=await Promise.all([randomUUID(),randomUUID()].map(id=>createWorkspace(root,id,repository))),identities=workspaces.map(()=>({runId:randomUUID(),executorId:randomUUID(),epoch:"1"}));
  const backend=new DockerRuntimeBackend();
  for(let i=0;i<workspaces.length;i++)running.push(await backend.start(workspaces[i],undefined,identities[i],{url,token}));
  assert.equal(calls,2);assert.ok(running.every(agent=>agent.runtimeEvidence?.platform==="linux"));
  const tools=await running[0].peer.command("get_commands");assert.ok(tools.success);
  const results=await Promise.all(running.map((agent,index)=>agent.peer.command("bash",{command:`node -e 'const fs=require("fs");const start=Date.now();setTimeout(()=>{fs.writeFileSync("shared.txt","writer-${index}\\n");console.log(JSON.stringify({start,end:Date.now(),cwd:process.cwd(),secret:process.env.BETTER_AUTH_SECRET??null,docker:fs.existsSync("/var/run/docker.sock")}));},500);'`})));
  const intervals=results.map(result=>{assert.equal((result.data as {exitCode:number}).exitCode,0);return JSON.parse((result.data as {output:string}).output);});assert.ok(Math.max(...intervals.map(x=>x.start))<Math.min(...intervals.map(x=>x.end)));
  for(let i=0;i<workspaces.length;i++){assert.equal(await readFile(path.join(workspaces[i].checkout,"shared.txt"),"utf8"),`writer-${i}\n`);assert.equal(intervals[i].secret,null);assert.equal(intervals[i].docker,false);assert.equal(intervals[i].cwd,"/work/checkout");assert.equal((await inspectContainerExit(root,workspaces[i].id,identities[i])).safe,false);}
  assert.equal(await readFile(path.join(repository,"shared.txt"),"utf8"),"base\n");
  const denied=await running[0].peer.command("bash",{command:"node -e 'fetch(\"http://127.0.0.1:39871/v1/coordinate\",{method:\"POST\",body:\"{}\"}).then(r=>console.log(r.status))'"});assert.equal((denied.data as {output:string}).output.trim(),"403");assert.equal(calls,2);
  const isolated=await running[0].peer.command("bash",{command:"node -e 'fetch(\"https://example.com\",{signal:AbortSignal.timeout(1000)}).then(()=>process.exit(3),()=>console.log(\"network blocked\"));try{require(\"fs\").writeFileSync(\"/opt/pi/escape\",\"bad\");process.exit(4)}catch{}'"});assert.equal((isolated.data as {output:string}).output.trim(),"network blocked");assert.equal((isolated.data as {exitCode:number}).exitCode,0);
  await Promise.all(running.map(agent=>agent.stop()));for(let i=0;i<workspaces.length;i++)assert.equal((await inspectContainerExit(root,workspaces[i].id,identities[i])).code,"stop_confirmed");
 }finally{await Promise.allSettled(running.map(agent=>agent.stop()));server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true});}
});
