export const serviceSource = `
const http=require('node:http'),fs=require('node:fs');
if(!fs.existsSync('build-proof.txt'))throw new Error('Build step missing');
if(process.env.DATABASE_URL||process.env.PI_COLLAB_EXECUTOR_DATABASE_URL||process.env.BETTER_AUTH_SECRET)throw new Error('Host secret inherited');
let count=0;
http.createServer((req,res)=>{
 if(req.url==='/redaction'){process.stdout.write('sk');setTimeout(()=>{process.stdout.write('-proj-'+('private-fixture-'.repeat(2000))+'\\nredaction complete\\n');res.end('logged');},20);return;}
 if(req.url==='/headers'){res.setHeader('content-type','application/json');res.end(JSON.stringify({cookie:req.headers.cookie??null,authorization:req.headers.authorization??null}));return;}
 if(req.url==='/redirect'){res.writeHead(302,{location:'/'});res.end();return;}
 if(req.url==='/api'){if(req.method==='POST')count++;res.setHeader('content-type','application/json');res.end(JSON.stringify({count}));return;}
 res.setHeader('content-type','text/html');res.setHeader('set-cookie','project_cookie=never-forward');
 res.end('<!doctype html><html><meta charset="utf-8"><title>Dynamic checkpoint</title><body><h1>固定快照动态服务</h1><button id="call">调用后端计数</button><p id="result">未请求</p><p id="sandbox"></p><script>document.querySelector("#call").onclick=async()=>{try{const r=await fetch("api",{method:"POST",headers:{"content-type":"application/json"},body:"{}"});const v=await r.json();document.querySelector("#result").textContent="服务计数 "+v.count;}catch{document.querySelector("#result").textContent="请求失败";}};try{document.cookie;document.querySelector("#sandbox").textContent="unexpected cookie access";}catch{document.querySelector("#sandbox").textContent="Cookie 已隔离";}</script></body></html>');
}).listen(Number(process.env.PORT),process.env.HOST,()=>console.log('service ready on allocated loopback'));
`;
export const buildProof = { version: 1 as const, steps: [{ tool: "node" as const, args: ["-e", "require('node:fs').writeFileSync('build-proof.txt','built in isolated preview')"], timeoutSeconds: 10 }] };
export const emptyPackage = JSON.stringify({name:"preview-fixture",version:"1.0.0"});
export const emptyLock = JSON.stringify({name:"preview-fixture",version:"1.0.0",lockfileVersion:3,packages:{"":{name:"preview-fixture",version:"1.0.0"}}});
