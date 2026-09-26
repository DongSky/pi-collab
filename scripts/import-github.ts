import { parseArgs } from "node:util";
import path from "node:path";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { GitHubError, githubMasterKey, readPrivateGitHubFile } from "../lib/collab/git/github-credentials";
import { registerGitHubInstallation, bindGitHubRepository, refreshGitHubInstallation } from "../lib/collab/git/github-registration";
import { syncGitHubRepository, reconcileGitHubSync } from "../lib/collab/git/github-sync";
import { importGitHubRepository } from "../lib/collab/git/github-import";
import { connectionString, dataRoot, localConfig } from "./local-config";

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  organization: { type: "string" }, actor: { type: "string" }, app: { type: "string" }, installation: { type: "string" }, account: { type: "string" }, "private-key": { type: "string" },
  repository: { type: "string" }, connection: { type: "string" }, "github-repository": { type: "string" }, reason: { type: "string" }, "request-id": { type: "string" },
  "expected-version": { type: "string" }, enable: { type: "boolean", default: false }, job: { type: "string" }, project: { type: "string" }, name: { type: "string" },
} });
const action = positionals[0];
if (positionals.length !== 1 || !["register", "bind", "import", "sync", "reconcile", "refresh", "rotate-key"].includes(action) || !values.actor || !values.reason
  || (action === "register" && (!values.organization || !values.app || !values.installation || !values.account || !values["private-key"]))
  || (["refresh","rotate-key"].includes(action) && (!values.connection || !values["expected-version"]))
  || (action === "rotate-key" && !values["private-key"])
  || (action === "bind" && (!values.repository || !values.connection || !values["github-repository"]))
  || (action === "sync" && !values.repository) || (action === "reconcile" && !values.job)
  || (action === "import" && (!values.project || !values.name || !values.connection || !values["github-repository"]))) {
  throw new Error("Usage: npm run github:import -- register --organization UUID --actor EMAIL --app ID --installation ID --account ID --private-key PRIVATE_FILE --reason TEXT [--request-id UUID]; or bind --repository LOCAL_UUID --connection UUID --github-repository ID --actor EMAIL --reason TEXT [--request-id UUID]; or import --project UUID --name NAME --connection UUID --github-repository ID --actor EMAIL --reason TEXT [--request-id UUID]; or sync --repository LOCAL_UUID --actor EMAIL --reason TEXT [--request-id UUID]; or reconcile --job SYNC_UUID --actor EMAIL --reason TEXT. Registration requires an organization administrator with MFA; binding/import/sync/reconcile require a project maintainer with MFA. Lifecycle: refresh --connection UUID --expected-version N --actor EMAIL --reason TEXT [--enable]; rotate-key accepts the same flags plus --private-key PRIVATE_FILE. Only github.com is supported.");
}
const admin = new Pool({ connectionString: connectionString(await localConfig(), true), connectionTimeoutMillis: 5000, query_timeout: 5000, statement_timeout: 5000 });
let master: Buffer | undefined, pem: Buffer | undefined;
const requestId = values["request-id"] ?? randomUUID();
if (action === "reconcile") console.log(`GitHub sync reconciliation job ID: ${values.job}. Reuse the same job ID to inspect this operation again.`);
else console.log(`GitHub ${action} request ID: ${requestId}. Reuse it with the same fields after an uncertain response.`);
try {
  const actor = (await admin.query('SELECT id FROM public."user" WHERE email=$1', [values.actor.toLowerCase()])).rows[0];
  if (!actor) throw new GitHubError("github_actor_unavailable");
  const configured = (await admin.query("SELECT 1 FROM collab_git.credentials LIMIT 1")).rowCount !== 0;
  master = action === "reconcile" ? Buffer.alloc(0) : await githubMasterKey(path.join(dataRoot, "git-master.key"), action === "register" && !configured);
  if (action === "refresh" || action === "rotate-key") {
    if (action === "rotate-key") pem = await readPrivateGitHubFile(values["private-key"]!);
    console.log(JSON.stringify(await refreshGitHubInstallation(admin,master,{connectionId:values.connection!,actorId:actor.id,expectedVersion:values["expected-version"]!,reason:values.reason,idempotencyKey:requestId,enable:values.enable},pem)));
  } else if (action === "register") {
    pem = await readPrivateGitHubFile(values["private-key"]!);
    console.log(JSON.stringify(await registerGitHubInstallation(admin, master, { organizationId: values.organization!, actorId: actor.id, appId: values.app!, installationId: values.installation!, accountId: values.account!, reason: values.reason, idempotencyKey: requestId }, pem)));
  } else if (action === "sync") console.log(JSON.stringify(await syncGitHubRepository(admin, dataRoot, master, { repositoryId: values.repository!, actorId: actor.id, reason: values.reason, idempotencyKey: requestId })));
  else if (action === "reconcile") console.log(JSON.stringify(await reconcileGitHubSync(admin, dataRoot, values.job!, actor.id, values.reason)));
  else if (action === "import") console.log(JSON.stringify(await importGitHubRepository(admin, dataRoot, master, { projectId: values.project!, name: values.name!, connectionId: values.connection!, githubRepositoryId: values["github-repository"]!, actorId: actor.id, reason: values.reason, idempotencyKey: requestId })));
  else console.log(JSON.stringify(await bindGitHubRepository(admin, master, { repositoryId: values.repository!, connectionId: values.connection!, githubRepositoryId: values["github-repository"]!, actorId: actor.id, reason: values.reason, idempotencyKey: requestId })));
} catch (error) {
  console.error(error instanceof GitHubError ? error.code : "github_operation_failed: verify explicit inputs, private file permissions, migration and network availability; no credential or provider response is printed.");
  process.exitCode = 1;
} finally { pem?.fill(0); master?.fill(0); await admin.end(); }
