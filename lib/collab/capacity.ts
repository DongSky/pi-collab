import { asUser } from "./database";
import { uuid } from "./projects";
import { capacityInput } from "./capacity-schema";
export function capacityContext(user: string, project: string) {
 uuid.parse(project);return asUser(user,async db=>(await db.query("SELECT collab.capacity_context($1) AS result",[project])).rows[0].result);
}
export function configureCapacity(user: string,project:string,raw:unknown) {
 uuid.parse(project);const input=capacityInput.parse(raw);
 return asUser(user,async db=>(await db.query("SELECT collab.configure_capacity($1,$2) AS result",[project,input])).rows[0].result);
}
