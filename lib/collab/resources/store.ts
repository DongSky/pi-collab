import { Pool } from "pg";
import { randomBytes } from "node:crypto";
import { sealResourcePassword } from "./credentials";
export type ResourceJob = { id: string; resourceId: string; projectId: string; brokerId: string; dispatchId: string; sql: string; roleName: string; schemaName: string; sealed: unknown };
export class ResourceStore {
  readonly pool: Pool;
  constructor(readonly connectionString: string) {
    this.pool = new Pool({ connectionString, max: 4, connectionTimeoutMillis: 5000, query_timeout: 5000, statement_timeout: 5000 });
    this.pool.on("error", () => console.error("[pi-collab] Resource broker database unavailable; active jobs will stop."));
  }
  async provision(key: Buffer) {
    const pending: { id: string; projectId: string }[] = (await this.pool.query("SELECT collab_broker.pending_resources() AS result")).rows[0].result;
    for (const resource of pending) {
      const password = randomBytes(32).toString("hex"), sealed = sealResourcePassword(key, resource.id, resource.projectId, password);
      await this.pool.query("SELECT collab_broker.provision($1,$2,$3)", [resource.id, password, sealed]);
    }
  }
  async claim(broker: string): Promise<ResourceJob | null> { return (await this.pool.query("SELECT collab_broker.claim($1) AS result", [broker])).rows[0].result; }
  async bind(job: ResourceJob, pid: number): Promise<boolean> { return (await this.pool.query("SELECT collab_broker.bind_backend($1,$2,$3,$4) AS result", [job.id, job.brokerId, job.dispatchId, pid])).rows[0].result; }
  async heartbeat(job: ResourceJob): Promise<boolean> { return (await this.pool.query("SELECT collab_broker.heartbeat_job($1,$2,$3) AS result", [job.id, job.brokerId, job.dispatchId])).rows[0].result; }
  async terminate(job: ResourceJob) { await this.pool.query("SELECT collab_broker.terminate_job($1,$2,$3)", [job.id, job.brokerId, job.dispatchId]); }
  async finish(job: ResourceJob, outcome: string, result: unknown, error: string | null): Promise<string> { return (await this.pool.query("SELECT collab_broker.finish_job($1,$2,$3,$4,$5,$6) AS result", [job.id, job.brokerId, job.dispatchId, outcome, result ? JSON.stringify(result) : null, error])).rows[0].result; }
  async reconcile(): Promise<number> { return (await this.pool.query("SELECT collab_broker.reconcile() AS result")).rows[0].result; }
  async reconcileEnvironments():Promise<number> {return (await this.pool.query("SELECT collab_broker.reconcile_environments() AS result")).rows[0].result;}
  close() { return this.pool.end(); }
}
