import { endpoint, identity } from "@/lib/collab/http";
import { operationsStatus } from "@/lib/collab/operations";
export const dynamic="force-dynamic";
export function GET(request:Request) { return endpoint(request,async()=>{await identity(request);return operationsStatus();}); }
