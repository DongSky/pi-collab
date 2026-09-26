import { Pool } from "pg";
import type { SealedCredential } from "./credentials";
export interface ModelProfile {
  id: string; organization_id: string; project_id: string; name: string; model_id: string;
  api: "openai-responses"; reasoning: boolean; context_window: number; max_output_tokens: number;
  run_token_limit: number; run_request_limit: number; enabled: boolean;
}
export class GatewayStore {
  readonly pool: Pool;
  constructor(connectionString: string) { this.pool = new Pool({ connectionString, max: 8, connectionTimeoutMillis: 3000, query_timeout: 3000, statement_timeout: 3000 }); }
  async profile(digest: string): Promise<ModelProfile> { return (await this.pool.query("SELECT collab_gateway.profile($1) AS result", [digest])).rows[0].result; }
  async valid(digest: string): Promise<boolean> { return (await this.pool.query("SELECT collab_gateway.valid($1) AS result", [digest])).rows[0].result; }
  async admit(digest: string, request: string, inputBound: number, outputBound: number): Promise<{ profile: ModelProfile; sealed: SealedCredential }> {
    const result = (await this.pool.query("SELECT collab_gateway.admit($1,$2,$3,$4) AS result", [digest, request, inputBound, outputBound])).rows[0].result;
    if (!result) throw new Error("model_unavailable");
    return result;
  }
  async settle(request: string, outcome: "completed" | "unknown", input?: number, output?: number) { await this.pool.query("SELECT collab_gateway.settle($1,$2,$3,$4)", [request, outcome, input ?? null, output ?? null]); }
  close() { return this.pool.end(); }
}
