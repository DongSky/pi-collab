import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { sealCredential, type ProviderSecret } from "./credentials";
import { asUser } from "../database";
import { projectRole, uuid } from "../projects";

const profileInput = z.object({
  projectId: z.uuid(), actorId: z.string().min(1), name: z.string().trim().min(1).max(120), modelId: z.string().min(1).max(200),
  reasoning: z.boolean().default(false), contextWindow: z.number().int().min(1024).max(1000000).default(128000),
  maxOutputTokens: z.number().int().min(16).max(32768).default(8192),
  runTokenLimit: z.number().int().min(1024).max(10000000).default(1000000), runRequestLimit: z.number().int().min(1).max(100).default(32),
  dailyTokenLimit: z.number().int().min(1024).max(1000000000).default(10000000),
}).strict();
/** Trusted local administration only: imports one explicitly selected credential. */
export async function registerModelProfile(admin: Pool, key: Buffer, raw: z.input<typeof profileInput>, secret: ProviderSecret) {
  const input = profileInput.parse(raw), id = randomUUID();
  if (input.runTokenLimit < input.contextWindow + input.maxOutputTokens) throw new Error("Run token budget must cover one context/output reservation");
  if (input.dailyTokenLimit < input.contextWindow + input.maxOutputTokens) throw new Error("Project daily budget must cover one context/output reservation");
  const client = await admin.connect();
  try {
    await client.query("BEGIN"); await client.query("SELECT set_config('collab.user_id',$1,true)", [input.actorId]);
    const project = (await client.query("SELECT organization_id FROM collab.projects WHERE id=$1 AND collab.project_role(id)='maintainer'", [input.projectId])).rows[0];
    if (!project) throw new Error("Model registration requires an active project maintainer");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,811))", [project.organization_id]);
    if (!(await client.query("SELECT 1 WHERE collab.project_role($1)='maintainer' AND (NOT collab.user_requires_mfa(collab.actor()) OR collab.actor_has_mfa())", [input.projectId])).rowCount) throw new Error("Maintainer authorization and administrator MFA are required");
    await client.query("INSERT INTO collab.model_profiles(id,organization_id,project_id,name,model_id,api,reasoning,context_window,max_output_tokens,run_token_limit,run_request_limit) VALUES($1,$2,$3,$4,$5,'openai-responses',$6,$7,$8,$9,$10)", [id, project.organization_id, input.projectId, input.name, input.modelId, input.reasoning, input.contextWindow, input.maxOutputTokens, input.runTokenLimit, input.runRequestLimit]);
    await client.query("INSERT INTO collab_gateway.credentials(profile_id,sealed) VALUES($1,$2)", [id, sealCredential(key, id, input.projectId, secret)]);
    // Adding a model must never silently raise an existing project's shared budget.
    await client.query("INSERT INTO collab_gateway.project_budgets(project_id,daily_token_limit) VALUES($1,$2) ON CONFLICT DO NOTHING", [input.projectId, input.dailyTokenLimit]);
    await client.query("INSERT INTO collab.audit_events(organization_id,project_id,actor_id,action,resource_id,detail) VALUES($1,$2,$3,'model.registered',$4,$5)", [project.organization_id, input.projectId, input.actorId, id, { source: "local-administrator-cli", api: "openai-responses", modelId: input.modelId }]);
    await client.query("COMMIT"); return { id, name: input.name, modelId: input.modelId };
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
export function listModelProfiles(userId: string, projectId: string) {
  uuid.parse(projectId);
  return asUser(userId, async db => {
    await projectRole(db, projectId, "project.read");
    return { models: (await db.query("SELECT id,name,model_id,api,reasoning,context_window,max_output_tokens,run_token_limit,run_request_limit,enabled FROM collab.model_profiles WHERE project_id=$1 ORDER BY created_at", [projectId])).rows };
  });
}
