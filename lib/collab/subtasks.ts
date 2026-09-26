import { z } from "zod";
import { asUser } from "./database";
import { subtaskAction, subtaskDecision, subtaskPolicy, subtaskProposal, type SubtaskContext } from "./subtask-schema";
export function subtaskContext(user: string, task: string): Promise<SubtaskContext> { z.uuid().parse(task); return asUser(user, async db => (await db.query("SELECT collab.subtask_context($1) AS result", [task])).rows[0].result); }
export function proposeSubtask(user: string, run: string, input: unknown) { z.uuid().parse(run); const value = subtaskProposal.parse(input); return asUser(user, async db => (await db.query("SELECT collab.propose_subtask($1,$2) AS result", [run, value])).rows[0].result); }
export function decideSubtask(user: string, proposal: string, input: unknown) { z.uuid().parse(proposal); const value = subtaskDecision.parse(input); return asUser(user, async db => (await db.query("SELECT collab.decide_subtask($1,$2) AS result", [proposal, value])).rows[0].result); }
export function actOnSubtasks(user: string, task: string, input: unknown) { z.uuid().parse(task); const value = subtaskAction.parse(input); return asUser(user, async db => (await db.query("SELECT collab.subtask_action($1,$2) AS result", [task, value])).rows[0].result); }
export function configureSubtasks(user: string, project: string, input: unknown) { z.uuid().parse(project); const value = subtaskPolicy.parse(input); return asUser(user, async db => (await db.query("SELECT collab.configure_subtasks($1,$2) AS result", [project, value])).rows[0].result); }
