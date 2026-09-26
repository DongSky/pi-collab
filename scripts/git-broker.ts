import { processGitLab } from "../lib/collab/gitlab/worker";
import path from "node:path";
import { Pool } from "pg";
import { processGitSync } from "../lib/collab/git/sync-broker";
import { processGitImport } from "../lib/collab/git/import-broker";
import { processWorkspaceGit } from "../lib/collab/git/workspace-broker";
import { processTaskPushPreview } from "../lib/collab/git/push-preview-broker";
import { processTaskPushDelivery } from "../lib/collab/git/push-delivery-broker";
import { processTaskPullProposal } from "../lib/collab/git/pull-proposal-broker";
import { processTaskPullDelivery } from "../lib/collab/git/pull-delivery-broker";
import { processPullRelease } from "../lib/collab/git/pull-release-broker";
import { processPullChecks } from "../lib/collab/git/pull-checks-broker";
import { processPullRevision } from "../lib/collab/git/pull-revision-broker";
import { processPullObservation } from "../lib/collab/git/pull-observation-broker";
import { githubMasterKey } from "../lib/collab/git/github-credentials";
import { dataRoot } from "./local-config";

if (!process.env.PI_COLLAB_GIT_DATABASE_URL) throw new Error("Configure the restricted Git role");
const pool = new Pool({ connectionString: process.env.PI_COLLAB_GIT_DATABASE_URL, max: 2, connectionTimeoutMillis: 5000, query_timeout: 10000, statement_timeout: 10000 });
const keyFile = process.env.PI_COLLAB_GIT_KEY_FILE ?? path.join(dataRoot, "git-master.key"), controller = new AbortController();
const master = () => {
  if (process.env.NODE_ENV === "production" && !process.env.PI_COLLAB_GIT_KEY_FILE) throw new Error("Configure the external Git key file for GitHub operations");
  return githubMasterKey(keyFile);
};
const stop = () => controller.abort(); process.on("SIGINT", stop); process.on("SIGTERM", stop);
console.log("pi-collab Git broker: native workspace operations, import, sync, push previews, explicit delivery, PR proposals, explicit draft creation, PR observations, fixed code revisions, trusted check observations and reconciliation, shared capacity 2");
const lane = async () => {
  let next = 0;
  const processors = [
    () => processGitLab(pool, dataRoot, master, { signal: controller.signal }),
    () => processWorkspaceGit(pool, dataRoot, { signal: controller.signal }),
    () => processGitImport(pool, dataRoot, master, { signal: controller.signal }),
    () => processGitSync(pool, dataRoot, master, { signal: controller.signal }),
    () => processTaskPushPreview(pool, dataRoot, master, { signal: controller.signal }),
    () => processTaskPushDelivery(pool, dataRoot, master, { signal: controller.signal }),
    () => processTaskPullProposal(pool, master, { signal: controller.signal }),
    () => processTaskPullDelivery(pool, master, { signal: controller.signal }),
    () => processPullObservation(pool, master, { signal: controller.signal }),
    () => processPullRevision(pool, dataRoot, master, { signal: controller.signal }),
    () => processPullChecks(pool, master, { signal: controller.signal }),
    () => processPullRelease(pool, master, { signal: controller.signal }),
  ];
  while (!controller.signal.aborted) {
    try {
      for (let offset = 0; offset < processors.length; offset++) {
        if (controller.signal.aborted) break;
        const index = (next + offset) % processors.length, result = await processors[index]();
        if (result) { next = (index + 1) % processors.length; console.log(`Git operation ${result.jobId}: ${result.outcome ?? result.status}`); break; }
      }
    } catch { console.error("Git broker cannot confirm this attempt; the original operation remains available for inspection."); }
    if (!controller.signal.aborted) await new Promise(resolve => setTimeout(resolve, 1000));
  }
};
try { await Promise.all([lane(), lane()]); }
finally { stop(); await pool.end(); }
