import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { notificationPreferences, setNotificationPreferences } from "@/lib/collab/notification-preferences";
export function GET(request:Request){return endpoint(request,async()=>notificationPreferences((await identity(request)).user.id));}
export function PUT(request:Request){return endpoint(request,async()=>setNotificationPreferences((await identity(request)).user.id,await jsonBody(request)));}
