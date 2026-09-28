import { endpoint, identity, jsonBody } from "@/lib/collab/http";
import { autoValidate } from "@/lib/collab/validation-auto";

/**
 * POST /api/collab/tasks/{id}/auto-validate
 *
 * Auto-validation skill: agent invokes this after making code changes.
 * Automatically detects project type, creates snapshot, runs tests.
 *
 * Body (all optional):
 *   - idempotencyKey: string (uuid)
 *   - command: string (override auto-detected test command, e.g. "npm run test:unit")
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => {
    const userId = (await identity(request)).user.id;
    const taskId = (await context.params).id;
    const body = (await jsonBody(request)) as { idempotencyKey?: string; command?: string };
    return autoValidate(userId, taskId, {
      ...(body.idempotencyKey ? { idempotencyKey: body.idempotencyKey } : {}),
      ...(body.command ? { command: body.command } : {}),
    });
  }, 202);
}
