import { previewDiscussionContext,submitDiscussionContext } from "../../lib/collab/discussion-context";
import { inbox, discussionCommand } from "../../lib/collab/discussions";
import { notificationPreferences, setNotificationPreferences } from "../../lib/collab/notification-preferences";
import { editTask } from "../../lib/collab/task-lifecycle";
import { coordinate } from "../../lib/collab/coordination-server";
import { answerQuestion, runQuestions } from "../../lib/collab/run-questions";
import test, { before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { localConfig, applicationEnvironment, connectionString, executorConnectionString } from "../../scripts/local-config";
import { startNativeDatabase } from "../../scripts/native-database";
import { migrate } from "../../scripts/migrate";
import { provisioningAuth } from "../../lib/collab/auth";
import { database, asUser } from "../../lib/collab/database";
import { createProject } from "../../lib/collab/projects";
import { createTask } from "../../lib/collab/tasks";
import { startRun, stopRun, runDetail } from "../../lib/collab/runs";
import { ExecutionStore } from "../../lib/collab/execution-store";
import { runControl, requestRunControl, decideRunControl, submitRunInstruction } from "../../lib/collab/run-control";

const config = await localConfig(), name = `pi_collab_test_${randomBytes(6).toString("hex")}`, native = await startNativeDatabase(config);
Object.assign(process.env, applicationEnvironment(config), { DATABASE_URL: connectionString(config, false, name) });
const admin = new Pool({ connectionString: connectionString(config, true, name) });
const store = new ExecutionStore(executorConnectionString(config, name));
const org = randomUUID(), repository = randomUUID(), executor = randomUUID(), users: string[] = [];
let project: string;
before(async () => {
 await migrate(config, name); const auth = provisioningAuth(admin);
 for (let i = 0; i < 5; i++) users.push((await auth.api.signUpEmail({ body: { name: `Controller ${i}`, email: `control${i}@test.invalid`, password: randomBytes(20).toString("hex") } })).user.id);
 await admin.query("INSERT INTO collab.organizations(id,name,created_by) VALUES($1,'Control team',$2)", [org, users[0]]);
 for (let i = 0; i < 4; i++) await admin.query("INSERT INTO collab.memberships(organization_id,user_id,role) VALUES($1,$2,$3)", [org, users[i], i === 0 ? "owner" : "member"]);
 await admin.query('UPDATE public."user" SET "twoFactorEnabled"=true WHERE id=$1', [users[0]]);
 project = (await createProject(users[0], { organizationId: org, name: "Shared run control", description: "" })).id;
 for (let i = 1; i < 4; i++) await admin.query("INSERT INTO collab.project_memberships(organization_id,project_id,user_id,role) VALUES($1,$2,$3,$4)", [org, project, users[i], i === 3 ? "reviewer" : "developer"]);
 await admin.query("INSERT INTO collab.repositories(id,organization_id,project_id,name,provider,base_sha,default_branch) VALUES($1,$2,$3,'Protocol only','local',$4,'main')", [repository, org, project, "a".repeat(40)]);
});
afterEach(async () => {
 for (const r of (await admin.query("SELECT r.id,r.status,r.epoch,c.version FROM collab.runs r JOIN collab.run_controls c ON c.run_id=r.id WHERE r.status IN ('queued','starting','running','waiting_input','stopping')")).rows) {
  await stopRun(users[0], r.id, { idempotencyKey: randomUUID(), controlVersion: r.version });
  if (r.status !== "queued") await store.finish(executor, r.id, r.epoch, "cancelled", {});
 }
});
after(async () => {
 await store.close(); await database().end(); globalThis.__piCollabPool = undefined; await admin.end();
 const cleanup = new Pool({ connectionString: connectionString(config, true, "postgres") }); await cleanup.query(`DROP DATABASE "${name}" WITH (FORCE)`); await cleanup.end(); await native.stop();
});
const request = (version = "1") => ({ expectedVersion: version, note: "I can take over the remaining implementation", idempotencyKey: randomUUID() });
const decision = (version = "1", action: "accept" | "reject" | "withdraw" = "accept") => ({ ...request(version), action, note: "Reviewed the handoff and remaining work" });
const instruction = (version = "1") => ({ expectedVersion: version, kind: "steer" as const, message: "Please focus on the remaining tests", idempotencyKey: randomUUID() });
async function running() {
 const task = await createTask(users[1], project, { title: "Shared task", description: "", acceptance: "" });
 const accepted = await startRun(users[1], task.id, { repositoryId: repository, baseSha: "a".repeat(40), prompt: "Protocol control test", expectedVersion: task.version, idempotencyKey: randomUUID() });
 const claim = await store.claim(executor, "native"); assert.equal(claim?.run.id, accepted.runId);
 // This SQL protocol fixture never provisions files; settle its zero-byte usage.
 await store.recordWorkspaceUsage(claim!.workspace.id,claim!.run.epoch,{bytes:0,error:null});
 await store.running(executor, accepted.runId, claim!.run.epoch);
 return { task, runId: accepted.runId, claim: claim! };
}

test("AI questions persist once, notify once and only the current controller can answer after handoff", async () => {
 const run=await running(),input={question:"Which interface should be implemented?",choices:["REST","GraphQL"],idempotencyKey:randomUUID()};
 const ask=()=>coordinate(store,executor,run.runId,run.claim.run.epoch,"ask_user",input);
 const q=await ask();assert.equal(q.status,"pending");assert.deepEqual(await ask(),q);
 assert.equal((await runQuestions(users[3],run.runId)).questions.length,1);
 assert.equal((await runDetail(users[1],run.runId)).run.status,"waiting_input");
 assert.equal((await inbox(users[1])).items.filter(n=>n.task_id===run.task.id&&n.kind==="run.waiting_input").length,1);
 await assert.rejects(runQuestions(users[4],run.runId),/不存在/);
 await assert.rejects(coordinate(store,executor,run.runId,run.claim.run.epoch,"ask_user",{...input,idempotencyKey:randomUUID()}),/question_pending/);
 await assert.rejects(coordinate(store,executor,run.runId,run.claim.run.epoch,"ask_user",{...input,question:"Changed request"}),/idempotency_conflict/);
 const response={expectedVersion:"1",answer:"REST with an OpenAPI schema",idempotencyKey:randomUUID()};
 await assert.rejects(answerQuestion(users[3],q.questionId,response),/forbidden/);
 const handoff=await requestRunControl(users[2],run.runId,request());await decideRunControl(users[1],handoff.requestId,decision());
 await assert.rejects(answerQuestion(users[1],q.questionId,response),/forbidden/);
 await assert.rejects(answerQuestion(users[2],q.questionId,response),/stale_control/);
 const current={...response,expectedVersion:"2"};await answerQuestion(users[2],q.questionId,current);
 assert.equal((await answerQuestion(users[2],q.questionId,current)).replayed,true);
 await assert.rejects(answerQuestion(users[2],q.questionId,{...current,answer:"Changed answer"}),/idempotency_conflict/);
 await assert.rejects(answerQuestion(users[2],q.questionId,{...current,idempotencyKey:randomUUID()}),/question_closed/);
 const accepted=await ask();assert.equal(accepted.answer,current.answer);assert.equal(accepted.answeredBy,users[2]);assert.equal(accepted.controlVersion,"2");
 assert.equal((await runDetail(users[1],run.runId)).run.status,"running");
 await assert.rejects(asUser(users[2],db=>db.query("UPDATE collab.run_questions SET answer='forged'")),/permission/);
});

test("stopping cancels pending AI questions and fences later polls and answers", async()=>{
 const run=await running(),input={question:"Human decision required",choices:[],idempotencyKey:randomUUID()};
 const q=await coordinate(store,executor,run.runId,run.claim.run.epoch,"ask_user",input);
 await stopRun(users[1],run.runId,{idempotencyKey:randomUUID(),controlVersion:"1"});
 assert.equal((await runQuestions(users[1],run.runId)).questions[0].status,"cancelled");
 await assert.rejects(answerQuestion(users[1],q.questionId,{expectedVersion:"1",answer:"Too late",idempotencyKey:randomUUID()}),/question_closed/);
 await assert.rejects(coordinate(store,executor,run.runId,run.claim.run.epoch,"ask_user",input),/run_not_executable/);
});

test("live control transfers cancel unsent old instructions, preserve provenance and do not affect other AI runs", async () => {
 const a = await running(), independent = await running();
 const queued = await submitRunInstruction(users[1], a.runId, instruction());
 const req = request(), asked = await requestRunControl(users[2], a.runId, req);
 assert.equal((await requestRunControl(users[2], a.runId, req)).requestId, asked.requestId);
 assert.equal((await inbox(users[1])).items.filter(n=>n.task_id===a.task.id&&n.kind==="control.requested").length,1);
 assert.equal((await inbox(users[2])).items.filter(n=>n.task_id===a.task.id&&n.kind==="control.requested").length,0);
 const approval = decision(); const result = await decideRunControl(users[1], asked.requestId, approval);
 assert.equal(result.controlVersion, "2");
 assert.equal((await decideRunControl(users[1], asked.requestId, approval)).replayed, true);
 assert.equal((await inbox(users[2])).items.filter(n=>n.task_id===a.task.id&&n.kind==="control.accepted").length,1);
 const visible = await runControl(users[3], a.runId);
 assert.equal(visible.run.requested_by, users[1]); assert.equal(visible.run.control.controllerId, users[2]);
 assert.equal(visible.instructions.find(i => i.id === queued.instructionId)?.status, "cancelled");
 assert.equal((await store.heartbeat(executor, independent.runId, independent.claim.run.epoch)).canExecute, true);
 await assert.rejects(submitRunInstruction(users[1], a.runId, instruction()), /forbidden/);
 await assert.rejects(stopRun(users[1], a.runId, { idempotencyKey: randomUUID(), controlVersion: "1" }), /forbidden/);
 const sent = await submitRunInstruction(users[2], a.runId, instruction("2"));
 const payload = await store.claimInstruction(executor, a.runId, a.claim.run.epoch);
 assert.equal(payload?.id, sent.instructionId); assert.equal(payload?.authorId, users[2]);
 await store.finishInstruction(executor, a.runId, a.claim.run.epoch, sent.instructionId, "delivered");
 assert.equal(await store.claimInstruction(executor, a.runId, a.claim.run.epoch), null);
 await stopRun(users[2], a.runId, { idempotencyKey: randomUUID(), controlVersion: "2" });
 assert.equal((await runDetail(users[1], a.runId)).run.status, "stopping");
 assert.equal((await runDetail(users[1], independent.runId)).run.status, "running");
});

test("reviewers and outsiders cannot request, approve, instruct or mutate the control tables", async () => {
 const r = await running();
 await assert.rejects(requestRunControl(users[3], r.runId, request()), /forbidden/);
 await assert.rejects(runControl(users[4], r.runId), /不存在/);
 await assert.rejects(submitRunInstruction(users[2], r.runId, instruction()), /forbidden/);
 const asked = await requestRunControl(users[2], r.runId, request());
 await assert.rejects(decideRunControl(users[2], asked.requestId, decision()), /forbidden/);
 await assert.rejects(decideRunControl(users[3], asked.requestId, decision()), /forbidden/);
 await assert.rejects(asUser(users[1], db => db.query("UPDATE collab.run_controls SET controller_id=$1 WHERE run_id=$2", [users[2], r.runId])), /permission/);
 await assert.rejects(asUser(users[1], db => db.query("DELETE FROM collab.control_requests WHERE id=$1", [asked.requestId])), /permission/);
});

test("returning control never revives old browser versions and decision races yield only one controller", async () => {
 const r = await running();
 const b = await requestRunControl(users[2], r.runId, request()), owner = await requestRunControl(users[0], r.runId, request());
 const decisions = await Promise.allSettled([decideRunControl(users[1], b.requestId, decision()), decideRunControl(users[1], owner.requestId, decision())]);
 assert.equal(decisions.filter(d => d.status === "fulfilled").length, 1);
 const current = (await runControl(users[1], r.runId)).run.control;
 const back = await requestRunControl(users[1], r.runId, request("2"));
 await decideRunControl(current.controllerId, back.requestId, decision("2"));
 await assert.rejects(submitRunInstruction(users[1], r.runId, instruction()), /stale_control/);
 await assert.rejects(stopRun(users[1], r.runId, { idempotencyKey: randomUUID() }), /stale_control/);
 await stopRun(users[1], r.runId, { idempotencyKey: randomUUID(), controlVersion: "3" });
});

test("withdraw/reject are shared and idempotent; authorization changes cannot revive an old request", async () => {
 const r = await running(); const q = await requestRunControl(users[2], r.runId, request());
 const withdraw = decision("1", "withdraw");
 await decideRunControl(users[2], q.requestId, withdraw);
 assert.equal((await decideRunControl(users[2], q.requestId, withdraw)).replayed, true);
 const rejected = await requestRunControl(users[2], r.runId, request());
 await decideRunControl(users[1], rejected.requestId, decision("1", "reject"));
 const stale = await requestRunControl(users[2], r.runId, request());
 await admin.query("UPDATE collab.project_memberships SET active=false WHERE project_id=$1 AND user_id=$2", [project, users[2]]);
 await admin.query("UPDATE collab.project_memberships SET active=true WHERE project_id=$1 AND user_id=$2", [project, users[2]]);
 await assert.rejects(decideRunControl(users[1], stale.requestId, decision()), /control_request_revoked/);
 assert.equal((await runControl(users[3], r.runId)).requests.find(q => q.id === rejected.requestId)?.status, "rejected");
});

test("revoking the delegated controller stops execution authorization even while the original owner remains authorized", async () => {
 const r = await running(); const q = await requestRunControl(users[2], r.runId, request()); await decideRunControl(users[1], q.requestId, decision());
 await admin.query("UPDATE collab.project_memberships SET active=false WHERE project_id=$1 AND user_id=$2", [project, users[2]]);
 try { assert.equal((await store.heartbeat(executor, r.runId, r.claim.run.epoch)).canExecute, false); }
 finally { await admin.query("UPDATE collab.project_memberships SET active=true WHERE project_id=$1 AND user_id=$2", [project, users[2]]); }
 assert.equal((await store.heartbeat(executor, r.runId, r.claim.run.epoch)).canExecute, false);
});

test("inflight and uncertain instructions block handoff and are never delivered twice", async () => {
 const r = await running(), body = instruction();
 const sent = await submitRunInstruction(users[1], r.runId, body);
 assert.equal((await submitRunInstruction(users[1], r.runId, body)).instructionId, sent.instructionId);
 await assert.rejects(submitRunInstruction(users[1], r.runId, { ...body, message: "Changed" }), /idempotency_conflict/);
 const item = await store.claimInstruction(executor, r.runId, r.claim.run.epoch); assert.equal(item?.id, sent.instructionId);
 const q = await requestRunControl(users[2], r.runId, request());
 await assert.rejects(decideRunControl(users[1], q.requestId, decision()), /control_delivery_pending/);
 await store.finishInstruction(executor, r.runId, r.claim.run.epoch, sent.instructionId, "unknown");
 assert.equal(await store.claimInstruction(executor, r.runId, r.claim.run.epoch), null);
 await assert.rejects(decideRunControl(users[1], q.requestId, decision()), /control_delivery_pending/);
});


test("personal quiet periods preserve delivery, reject stale updates and cannot read or change another person's preference",async()=>{
 const until=new Date(Date.now()+3600000).toISOString();
 assert.equal((await notificationPreferences(users[1])).version,0);
 const saved=await setNotificationPreferences(users[1],{expectedVersion:0,quietUntil:until});
 assert.equal(saved.quiet,true);assert.equal(saved.quietUntil,until);
 assert.equal((await notificationPreferences(users[2])).quiet,false);
 await assert.rejects(asUser(users[2],db=>db.query("UPDATE collab.notification_preferences SET quiet_until=NULL WHERE user_id=$1",[users[1]])),/permission/);
 assert.equal((await asUser(users[2],db=>db.query("SELECT * FROM collab.notification_preferences WHERE user_id=$1",[users[1]]))).rowCount,0);
 await assert.rejects(setNotificationPreferences(users[1],{expectedVersion:0,quietUntil:null}),/stale_notification_preferences/);
 await assert.rejects(setNotificationPreferences(users[1],{expectedVersion:1,quietUntil:new Date(Date.now()+31*86400000).toISOString()}),/invalid_notification_preferences/);
 const r=await running();await requestRunControl(users[2],r.runId,request());
 const page=await inbox(users[1]);assert.equal(page.preferences.quiet,true);assert.ok(page.items.some(n=>n.task_id===r.task.id&&n.kind==="control.requested"&&!n.read_at));
 const race=await Promise.allSettled([setNotificationPreferences(users[1],{expectedVersion:1,quietUntil:null}),setNotificationPreferences(users[1],{expectedVersion:1,quietUntil:until})]);
 assert.equal(race.filter(r=>r.status==="fulfilled").length,1);
 await admin.query("UPDATE collab.notification_preferences SET quiet_until=now()-interval '1 second' WHERE user_id=$1",[users[1]]);
 assert.equal((await inbox(users[1])).preferences.quiet,false);assert.ok((await inbox(users[1])).items.some(n=>n.task_id===r.task.id&&!n.read_at));
});

test("review requests reach independent reviewers, respect unsubscribe and hide notifications after revocation",async()=>{
 const t=await createTask(users[1],project,{title:"Ready for independent review",description:"",acceptance:""});
 const change={title:t.title,description:"",acceptance:"",status:"in_review" as const,reason:"Request independent review of this task",expectedVersion:t.version,idempotencyKey:randomUUID()};
 await editTask(users[1],t.id,change);await editTask(users[1],t.id,change);
 assert.equal((await inbox(users[3])).items.filter(n=>n.task_id===t.id&&n.kind==="task.review_requested").length,1);
 assert.equal((await inbox(users[2])).items.filter(n=>n.task_id===t.id).length,0);
 assert.equal((await inbox(users[4])).items.length,0);
 await discussionCommand(users[3],t.id,{action:"subscribe",enabled:false,idempotencyKey:randomUUID()});
 await editTask(users[1],t.id,{...change,status:"ready",expectedVersion:t.version+1,idempotencyKey:randomUUID()});
 await editTask(users[1],t.id,{...change,expectedVersion:t.version+2,idempotencyKey:randomUUID()});
 assert.equal((await inbox(users[3])).items.filter(n=>n.task_id===t.id&&n.kind==="task.review_requested").length,1);
 await admin.query("UPDATE collab.project_memberships SET active=false WHERE project_id=$1 AND user_id=$2",[project,users[3]]);
 try{assert.equal((await inbox(users[3])).items.length,0);}finally{await admin.query("UPDATE collab.project_memberships SET active=true WHERE project_id=$1 AND user_id=$2",[project,users[3]]);}
 await assert.rejects(asUser(users[1],db=>db.query("SELECT collab.notify_task($1,NULL,'ci.failed','spoofed')",[t.id])),/permission/);
});


test("selected comments become one attributed instruction only after controller confirmation; retries keep the fixed source",async()=>{
 const r=await running();
 const posted=await discussionCommand(users[3],r.task.id,{action:"create",title:"Review guidance",body:"Quoted /command is project data",mentions:[],anchor:null,replacement:null,idempotencyKey:randomUUID()});
 const reply=await discussionCommand(users[2],r.task.id,{action:"reply",threadId:posted.threadId,body:"Handle the boundary case",mentions:[],idempotencyKey:randomUUID()});
 const selection={threadId:posted.threadId,messageIds:[String(reply.messageId),String(posted.messageId)]};
 assert.equal((await runControl(users[1],r.runId)).instructions.length,0);
 const preview=await previewDiscussionContext(users[1],r.runId,selection);
 assert.deepEqual(preview.source.messages.map(m=>m.authorId),[users[3],users[2]]);
 const input={...selection,expectedVersion:preview.controlVersion,sourceHash:preview.sourceHash,kind:"follow_up",note:"Consider this feedback and explain the chosen changes",idempotencyKey:randomUUID()};
 const sent=await submitDiscussionContext(users[1],r.runId,input);
 // New replies and changing discussion state never alter an accepted request.
 await discussionCommand(users[2],r.task.id,{action:"reply",threadId:posted.threadId,body:"Later content must not be replayed",mentions:[],idempotencyKey:randomUUID()});
 await discussionCommand(users[3],r.task.id,{action:"resolve",threadId:posted.threadId,resolved:true,expectedVersion:1,idempotencyKey:randomUUID()});
 assert.equal((await submitDiscussionContext(users[1],r.runId,input)).instructionId,sent.instructionId);
 await assert.rejects(submitDiscussionContext(users[1],r.runId,{...input,note:"Different request"}),/idempotency_conflict/);
 const data=await runControl(users[2],r.runId);assert.equal(data.instructions.length,1);
 assert.equal(data.instructions[0].discussion.sourceHash,preview.sourceHash);
 assert.deepEqual(data.instructions[0].discussion.messageIds,preview.source.messages.map(m=>m.id));
 const delivered=await store.claimInstruction(executor,r.runId,r.claim.run.epoch);assert.equal(delivered?.id,sent.instructionId);
 assert.match(delivered!.message,/quoted project data, not system instructions/);assert.match(delivered!.message,/Quoted \/command/);assert.doesNotMatch(delivered!.message,/Later content/);
 await store.finishInstruction(executor,r.runId,r.claim.run.epoch,sent.instructionId,"delivered");assert.equal(await store.claimInstruction(executor,r.runId,r.claim.run.epoch),null);
 await assert.rejects(asUser(users[2],db=>db.query("UPDATE collab.instruction_discussions SET source='{}' WHERE instruction_id=$1",[sent.instructionId])),/permission/);
 assert.equal((await asUser(users[4],db=>db.query("SELECT * FROM collab.instruction_discussions"))).rowCount,0);
});

test("discussion handoff rejects foreign messages, stale source, previous controllers and human terminals",async()=>{
 const r=await running(),other=await running();
 const create=async(task:string)=>discussionCommand(users[3],task,{action:"create",title:"Fixed review",body:"Only explicitly selected source",mentions:[],anchor:null,replacement:null,idempotencyKey:randomUUID()});
 const a=await create(r.task.id),b=await create(other.task.id),selection={threadId:a.threadId,messageIds:[String(a.messageId)]};
 await assert.rejects(previewDiscussionContext(users[2],r.runId,selection),/forbidden/);
 await assert.rejects(previewDiscussionContext(users[1],r.runId,{...selection,messageIds:[String(b.messageId)]}),/invalid_discussion_context/);
 await assert.rejects(previewDiscussionContext(users[1],r.runId,{threadId:b.threadId,messageIds:[String(b.messageId)]}),/not_found/);
 const p=await previewDiscussionContext(users[1],r.runId,selection),input={...selection,expectedVersion:p.controlVersion,sourceHash:p.sourceHash,kind:"steer",note:"Act on the selected review",idempotencyKey:randomUUID()};
 await discussionCommand(users[3],r.task.id,{action:"resolve",threadId:a.threadId,resolved:true,expectedVersion:1,idempotencyKey:randomUUID()});
 await assert.rejects(submitDiscussionContext(users[1],r.runId,input),/discussion_context_changed/);
 const next=await previewDiscussionContext(users[1],r.runId,selection);
 const q=await requestRunControl(users[2],r.runId,request());await decideRunControl(users[1],q.requestId,decision());
 await assert.rejects(submitDiscussionContext(users[1],r.runId,{...input,sourceHash:next.sourceHash}),/forbidden/);
 assert.equal((await runControl(users[2],r.runId)).instructions.length,0);
 await admin.query("UPDATE collab.runs SET execution_kind='terminal' WHERE id=$1",[r.runId]);
 await assert.rejects(previewDiscussionContext(users[2],r.runId,selection),/not_found/);
 await assert.rejects(submitDiscussionContext(users[2],r.runId,{...input,sourceHash:next.sourceHash,expectedVersion:"2"}),/not_found/);
});
