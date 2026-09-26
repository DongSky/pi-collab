import type { PoolClient } from "pg";
import { asUser } from "./database";
import { notificationPreferencesInput, type NotificationPreferences } from "./notification-schema";
export async function readNotificationPreferences(db:PoolClient):Promise<NotificationPreferences> {
 const row=(await db.query("SELECT version,quiet_until,coalesce(quiet_until>now(),false) AS quiet FROM collab.notification_preferences WHERE user_id=collab.actor()")).rows[0];
 return {version:row?.version??0,quietUntil:row?.quiet_until?.toISOString()??null,quiet:row?.quiet??false};
}
export function notificationPreferences(userId:string){return asUser(userId,readNotificationPreferences);}
export function setNotificationPreferences(userId:string,raw:unknown){
 const input=notificationPreferencesInput.parse(raw);
 return asUser(userId,async db=>{
  await db.query("SELECT collab.set_notification_quiet($1,$2)",[input.expectedVersion,input.quietUntil]);
  return readNotificationPreferences(db);
 });
}
