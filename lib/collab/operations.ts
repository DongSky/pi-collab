import { database } from "./database";
import { DomainError } from "./policy";
export async function operationsStatus() {
 return (await database().query("SELECT collab.operation_status() AS result")).rows[0].result as {draining:boolean;updatedAt:string};
}
export async function guardWebAdmission(request:Request) {
 if (["GET","HEAD","OPTIONS"].includes(request.method)) return;
 const pathname=new URL(request.url).pathname;
 // Stop and evidence-based recovery remain usable during drain. Authentication is separate.
 if (/\/runs\/[a-f0-9-]+\/(stop|actions|disposition)$/.test(pathname) || pathname.startsWith("/api/collab/auth/") || /\/service-previews\/[a-f0-9-]+\/stop$/.test(pathname)) return;
 if((await operationsStatus()).draining) throw new DomainError("installation_draining","实例正在排空升级，暂不接收新的修改；可继续查看和停止已有运行。",503);
}
