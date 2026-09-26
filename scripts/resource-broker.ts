import path from "node:path";
import { randomUUID } from "node:crypto";
import { masterKey } from "../lib/collab/gateway/credentials";
import { ResourceStore } from "../lib/collab/resources/store";
import { executeResourceJob } from "../lib/collab/resources/worker";
import { brokerConnectionString, dataRoot, localConfig } from "./local-config";
if (process.env.NODE_ENV === "production" && (!process.env.PI_COLLAB_BROKER_DATABASE_URL || !process.env.PI_COLLAB_RESOURCE_KEY_FILE)) throw new Error("Configure restricted resource broker role and external key");
const store = new ResourceStore(process.env.PI_COLLAB_BROKER_DATABASE_URL ?? brokerConnectionString(await localConfig()));
const file = process.env.PI_COLLAB_RESOURCE_KEY_FILE ?? path.join(dataRoot, "resource-master.key");
const existing = (await store.pool.query("SELECT collab_broker.has_credentials() AS present")).rows[0].present;
const key = await masterKey(file, process.env.NODE_ENV !== "production" && !existing);
const broker = randomUUID(), controller = new AbortController(), jobs = new Set<Promise<unknown>>();
process.on("SIGTERM", () => controller.abort()); process.on("SIGINT", () => controller.abort());
console.log(`pi-collab resource broker ${broker}: managed PostgreSQL, capacity 4`);
try {
  while (!controller.signal.aborted) {
    try {
      await store.reconcile(); await store.reconcileEnvironments(); await store.provision(key);
      while (jobs.size < 4 && !controller.signal.aborted) {
        const job = await store.claim(broker); if (!job) break;
        const work = executeResourceJob(store, job, key, controller.signal).then(status => console.log(`Resource job ${job.id}: ${status}`))
          .catch(() => console.error(`Resource job ${job.id}: outcome requires reconciliation`)).finally(() => jobs.delete(work));
        jobs.add(work);
      }
    } catch { console.error("Resource broker cannot reach authority; jobs will stop or await reconciliation."); }
    if (!controller.signal.aborted) await new Promise(resolve => setTimeout(resolve, 1000));
  }
} finally { controller.abort(); await Promise.allSettled(jobs); key.fill(0); await store.close(); }
