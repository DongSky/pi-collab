import {createRequire} from 'node:module';
import {createInterface} from 'node:readline';
import {execFile} from 'node:child_process';
const require=createRequire(import.meta.url),{spawn}=require('node-pty');
let terminal,exited=null,waiting=[],flowPaused=false;
const send=value=>{if(!process.stdout.write(JSON.stringify(value)+'\n')&&terminal){terminal.pause();flowPaused=true;}};
process.stdout.on('drain',()=>{if(flowPaused){flowPaused=false;terminal?.resume();}});
const reply=(command,data)=>send({id:command.id,type:'response',command:command.type,success:true,data});
const input=createInterface({input:process.stdin,crlfDelay:Infinity});
input.on('line',line=>{void (async()=>{
 let command;
 try{
  command=JSON.parse(line);
  if(command.type==='get_state')reply(command,{terminal:!!terminal,exitCode:exited});
  else if(command.type==='terminal_start'){
   if(terminal)throw new Error('Terminal already started');
   terminal=spawn('/bin/bash',['--noprofile','--norc','-i'],{name:'xterm-256color',cols:80,rows:24,cwd:process.cwd(),env:{...process.env,TERM:'xterm-256color',HISTFILE:'/dev/null',BASH_SILENCE_DEPRECATION_WARNING:'1',PS1:'pi-collab$ '}});
   terminal.onData(data=>{for(let offset=0;offset<data.length;offset+=16000)send({type:'terminal_output',text:data.slice(offset,offset+16000)});});
   terminal.onExit(({exitCode})=>{exited=exitCode;send({type:'terminal_exit',exitCode});for(const c of waiting)reply(c,{exitCode});waiting=[];});
   reply(command,{pid:terminal.pid});
  }else if(command.type==='terminal_wait'){
   if(exited!==null)reply(command,{exitCode:exited});else waiting.push(command);
  }else if(command.type==='terminal_input'){
   if(!terminal||exited!==null||typeof command.data!=='string'||command.data.length>8192)throw new Error('Terminal input rejected');terminal.write(command.data);reply(command,{accepted:true});
  }else if(command.type==='terminal_resize'){
   if(!terminal||exited!==null||!Number.isInteger(command.cols)||command.cols<20||command.cols>240||!Number.isInteger(command.rows)||command.rows<5||command.rows>100)throw new Error('Terminal resize rejected');terminal.resize(command.cols,command.rows);send({type:'terminal_resize',cols:command.cols,rows:command.rows});reply(command,{accepted:true});
  }else if(command.type==='bash'&&!terminal){
   if(typeof command.command!=='string')throw new Error('Invalid setup command');
   execFile('/bin/bash',['--noprofile','--norc','-c',command.command],{cwd:process.cwd(),env:process.env,timeout:120000,maxBuffer:1048576},error=>reply(command,{exitCode:error?1:0}));
  }else throw new Error('Unsupported terminal command');
 }catch{send({id:command?.id,type:'response',command:command?.type,success:false,error:'Terminal command rejected'});}
 })();});
// Supervisor owns session-wide termination and verifies descendants before marking stopped.
process.stdin.on('end',()=>process.exit(0));
