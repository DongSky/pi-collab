import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, readdir } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { Pool } from "pg";
import lockfile from "proper-lockfile";
import { provisioningAuth } from "../lib/collab/auth";
import { applicationEnvironment, connectionString, dataRoot, localConfig } from "./local-config";
import { importLocalRepository } from "../lib/collab/repository-import";
import { managedGit } from "../lib/collab/git/github-pack";
import { database } from "../lib/collab/database";
import { createTask } from "../lib/collab/tasks";
import { createValidationProfile } from "../lib/collab/validations";
import { publishIntegrationPolicy } from "../lib/collab/integration-reviews";

const { values } = parseArgs({ options: { prepare: { type: "boolean" } } });
if (!values.prepare || process.env.NODE_ENV === "production") throw new Error("Use npm run demo:live:prepare for a local development demo only.");
const config = await localConfig(); Object.assign(process.env, applicationEnvironment(config));
const directory = path.join(dataRoot, "live-demo"); await mkdir(directory, { recursive: true, mode: 0o700 });
const release = await lockfile.lock(directory, { retries: 0 });
const admin = new Pool({ connectionString: connectionString(config, true) });
type Account = { name: string; email: string; password: string; id: string };
type State = { version: 1; organizationId: string; projectId: string; accounts: Account[]; source: string;
 repository?: { id: string; baseSha: string; defaultBranch: string }; tasks?: { id: string; title: string; version: number }[];
 profiles?: string[]; policyId?: string; ready?: boolean; modelProfileId?: string };
const file = path.join(directory, "state.json");
const save = async (state: State) => { const tmp = file + ".tmp"; await writeFile(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 }); await rename(tmp, file); };
try {
 let state: State;
 try { state = JSON.parse(await readFile(file, "utf8")); if (state.version !== 1) throw new Error("Unsupported demo state"); }
 catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  state = { version: 1, organizationId: randomUUID(), projectId: randomUUID(), accounts: [], source: path.join(directory, "source") }; await save(state);
 }
 const auth = provisioningAuth(admin);
 for (const name of ["Owner", "Alice", "Bob", "Reviewer"]) {
  if (state.accounts.some(a => a.name === name)) continue;
  const account = { name, email: `live-${name.toLowerCase()}-${state.organizationId}@pi-collab.test`, password: randomBytes(24).toString("base64url"), id: "" };
  state.accounts.push(account); await save(state);
 }
 for (const account of state.accounts) {
  if (!account.id) {
   const prior = (await admin.query('SELECT id FROM public."user" WHERE email=$1', [account.email])).rows[0];
   account.id = prior?.id ?? (await auth.api.signUpEmail({ body: { name: `Live ${account.name}`, email: account.email, password: account.password } })).user.id;
   await save(state);
  }
 }
 const [owner, alice, bob, reviewer] = state.accounts;
 // Development provisioning follows dev:seed. No production organization,
 // membership, MFA flag or existing user's role is changed.
 const db = await admin.connect();
 try {
  await db.query("BEGIN");
  await db.query("INSERT INTO collab.organizations(id,name,created_by) VALUES($1,'真实双 AI 本机验收',$2) ON CONFLICT DO NOTHING", [state.organizationId, owner.id]);
  for (const a of state.accounts) await db.query("INSERT INTO collab.memberships(organization_id,user_id,role) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [state.organizationId, a.id, a.id === owner.id ? "owner" : "member"]);
  await db.query("INSERT INTO collab.projects(id,organization_id,name,description,created_by) VALUES($1,$2,'双 AI 商店开发','真实模型、独立工作区、固定检查与人工评审',$3) ON CONFLICT DO NOTHING", [state.projectId, state.organizationId, alice.id]);
  for (const [account, role] of [[alice,"maintainer"],[bob,"developer"],[reviewer,"reviewer"]] as const)
   await db.query("INSERT INTO collab.project_memberships(organization_id,project_id,user_id,role) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING", [state.organizationId, state.projectId, account.id, role]);
  await db.query("COMMIT");
 } catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
 if (!state.repository) {
  const existing = (await admin.query("SELECT id,base_sha,default_branch FROM collab.repositories WHERE project_id=$1 AND name='parallel-shop'", [state.projectId])).rows;
  if (existing.length > 1) throw new Error("Ambiguous demo repository; inspect before continuing");
  if (existing[0]) state.repository = { id: existing[0].id, baseSha: existing[0].base_sha, defaultBranch: existing[0].default_branch };
  else {
   await mkdir(state.source, { recursive: true, mode: 0o700 });
   const copy = async (from: string, to: string): Promise<void> => {
    await mkdir(to, { recursive: true, mode: 0o700 });
    for (const item of await readdir(from, { withFileTypes: true })) {
     if (item.isDirectory()) await copy(path.join(from, item.name), path.join(to, item.name));
     else {
      const bytes = await readFile(path.join(from, item.name)), target = path.join(to, item.name);
      try { await writeFile(target, bytes, { flag: "wx", mode: 0o600 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !(await readFile(target)).equals(bytes)) throw error; }
     }
    }
   };
   await copy(path.resolve("examples/parallel-shop"), state.source);
   const git = (args: string[]) => managedGit(state.source, args, AbortSignal.timeout(30000));
   await git(["init", "--template=", "-b", "main"]); await git(["config", "user.name", "pi-collab live demo"]); await git(["config", "user.email", "demo@pi-collab.test"]);
   await git(["add", "."]); await git(["commit", "-m", "Two independent coding tasks and fixed acceptance checks"]);
   state.repository = await importLocalRepository(admin, dataRoot, { projectId: state.projectId, actorId: alice.id, name: "parallel-shop", source: state.source });
  }
  await save(state);
 }
 const titles = ["Alice：实现折扣计算", "Bob：实现运费计算"];
 state.tasks ??= [];
 for (let i = state.tasks.length; i < 2; i++) {
  const account = i ? bob : alice;
  const prior = (await admin.query("SELECT id,title,version FROM collab.tasks WHERE project_id=$1 AND title=$2", [state.projectId, titles[i]])).rows;
  if (prior.length > 1) throw new Error("Ambiguous demo task");
  const task = prior[0] ?? await createTask(account.id, state.projectId, { title: titles[i], description: `仅修改 ${i ? "shipping.mjs" : "pricing.mjs"}，不得修改测试、checkout 或另一个任务的代码。`, acceptance: `node --test tests/${i ? "shipping" : "pricing"}.test.mjs 必须通过。` });
  state.tasks.push({ id: task.id, title: task.title, version: task.version }); await save(state);
 }
 state.profiles ??= [];
 for (let i = state.profiles.length; i < 3; i++) {
  const name = ["折扣单任务检查", "运费单任务检查", "双成果组合检查"][i];
  const prior = (await admin.query("SELECT id FROM collab.validation_profiles WHERE project_id=$1 AND repository_id=$2 AND name=$3", [state.projectId, state.repository.id, name])).rows;
  if (prior.length > 1) throw new Error("Ambiguous demo validation profile");
  const profileId = prior[0]?.id ?? (await createValidationProfile(alice.id, state.projectId, { repositoryId: state.repository.id, name, idempotencyKey: randomUUID(),
   config: { version: 1, steps: [{ tool: "node", args: ["--test", ...(i === 2 ? ["tests/pricing.test.mjs","tests/shipping.test.mjs","tests/checkout.test.mjs"] : [`tests/${i ? "shipping" : "pricing"}.test.mjs`])], timeoutSeconds: 30 }] } })).profileId;
  state.profiles.push(profileId); await save(state);
 }
 if (!state.policyId) {
  const prior = (await admin.query("SELECT id FROM collab.integration_policies WHERE repository_id=$1 ORDER BY version DESC LIMIT 1", [state.repository.id])).rows[0];
  state.policyId = prior?.id ?? (await publishIntegrationPolicy(alice.id, state.projectId, { repositoryId: state.repository.id, profileId: state.profiles[2], requiredApprovals: 1, reviewerApprovals: true,
   expectedVersion: 0, reason: "双人真实模型验收必须运行全部固定测试并由独立评审者确认。", idempotencyKey: randomUUID() })).policyId;
  await save(state);
 }
 state.ready = true; await save(state);
 console.log(JSON.stringify({ ready: true, projectId: state.projectId, repositoryId: state.repository.id, tasks: state.tasks.map(t => t.title), modelConfigured: !!state.modelProfileId,
  credentials: ".local/live-demo/state.json (private; never print)", url: `http://127.0.0.1:${config.port}` }));
} finally { await admin.end(); await database().end(); globalThis.__piCollabPool = undefined; await release(); }
