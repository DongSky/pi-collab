import {endpoint,jsonBody} from "@/lib/collab/http";
import {redeemAccountRecovery} from "@/lib/collab/account-recovery";
export async function POST(request:Request){return endpoint(request,async()=>redeemAccountRecovery(await jsonBody(request)));}
