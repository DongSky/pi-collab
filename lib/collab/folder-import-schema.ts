import { z } from "zod";
import { safeSnapshotPath } from "./snapshot-paths";
export const FOLDER_FILE_LIMIT=2*1024*1024, FOLDER_TOTAL_LIMIT=32*1024*1024, FOLDER_COUNT_LIMIT=2000;
export function folderExclusion(file:string):string|null {
 if(!safeSnapshotPath(file))return "不支持的路径（包括 Git 元数据）";
 const parts=file.toLowerCase().split("/"),name=parts.at(-1)!;
 if(parts.some(p=>[".pi",".agents",".ssh",".aws",".config",".local"].includes(p))||/^\.env(?:\.|$)/.test(name)||[".npmrc",".pypirc","auth.json","credentials.json","credentials","id_rsa","id_ed25519"].includes(name)||/\.(pem|key|p12|pfx|kdbx|keystore)$/.test(name))return "凭据或私人配置";
 if(parts.some(p=>["node_modules",".next",".cache",".venv","venv","__pycache__","coverage","dist","build",".turbo"].includes(p))||name===".ds_store")return "依赖或生成文件";
 return null;
}
export const folderInput=z.object({requestKey:z.uuid(),name:z.string().trim().min(1).max(120),files:z.array(z.object({path:z.string().max(1024),data:z.string().max(Math.ceil(FOLDER_FILE_LIMIT/3)*4).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)}).strict()).min(1).max(FOLDER_COUNT_LIMIT)}).strict();
export type FolderImportResult={repositoryId:string;taskId:string;sessionId:string;snapshotId:string;folderName:string;firstFile:string|null;excluded:{path:string;reason:string}[]};
