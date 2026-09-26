import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec=promisify(execFile);
// macOS ps redacts sess; getsid remains available through Python's POSIX API.
// Isolated Python ignores user packages and environment startup hooks.
const source=`import os,subprocess,json
rows=[]
for raw in subprocess.check_output(['/bin/ps','-axo','pid=']).split():
 try:
  pid=int(raw); rows.append({'pid':pid,'group':os.getpgid(pid),'session':os.getsid(pid)})
 except (ProcessLookupError,PermissionError): pass
print(json.dumps(rows))`;
export async function sessionProcesses(session:number):Promise<{pid:number;group:number;session:number}[]>{
 if(!Number.isInteger(session)||session<2)throw new Error("terminal_session_invalid");
 const {stdout}=await exec("python3",["-I","-S","-c",source],{timeout:5000,maxBuffer:2*1024*1024});
 const rows=JSON.parse(stdout);if(!Array.isArray(rows)||rows.some(r=>![r.pid,r.group,r.session].every(Number.isInteger)))throw new Error("terminal_session_inspection_failed");
 return rows.filter(r=>r.session===session);
}
