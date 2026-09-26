import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('native database starts and restarts under a data path longer than Unix socket limits', {timeout:60000}, async()=>{
 const base=await mkdtemp(path.join(tmpdir(),'pi-long-root-'));
 const root=path.join(base,'nested-data-directory-'.repeat(8));await mkdir(root);
 const program=`
 const {createServer}=await import('node:net');
 const {Client}=await import('pg');
 const {localConfig,connectionString}=await import('./scripts/local-config.ts');
 const {startNativeDatabase}=await import('./scripts/native-database.ts');
 const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));
 const config=await localConfig();config.databasePort=port;
 for(let i=0;i<2;i++){
  const db=await startNativeDatabase(config);if(!db.owned)throw Error('expected isolated database');
  const c=new Client({connectionString:connectionString(config,true,'postgres')});
  try{await c.connect();if(i===0){await c.query('CREATE TABLE restart_evidence(value text)');await c.query("INSERT INTO restart_evidence VALUES('persistent')");}
  const result=await c.query('SELECT value FROM restart_evidence');if(result.rows[0].value!=='persistent')throw Error('lost data');
  const sockets=await c.query('SHOW unix_socket_directories');if(sockets.rows[0].unix_socket_directories!=='')throw Error('unexpected sockets');
  }finally{await c.end();await db.stop();}
 }
 `;
 try{
  const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',program],{env:{...process.env,PI_COLLAB_DATA_DIR:root},stdio:['ignore','pipe','pipe']});let output='';for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{output+=b});
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)});assert.equal(code,0,output);
 }finally{await rm(base,{recursive:true,force:true});}
});
