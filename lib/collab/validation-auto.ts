import { randomUUID } from "node:crypto";
import { asUser } from "./database";
import { uuid } from "./projects";
import { DomainError } from "./policy";
import { detectTestCommand, describeTestCommand } from "./validation-autodetect";

/**
 * Auto-validation skill: encapsulates "create snapshot + run tests" as a single
 * operation that the agent can invoke after making code changes.
 *
 * Instead of the user manually going through:
 *   1. Create snapshot
 *   2. Select snapshot
 *   3. Type test command
 *   4. Run validation
 *
 * The agent (or system) calls this once, and it:
 *   1. Auto-detects the project's test command (npm test, pytest, go test, etc.)
 *   2. Creates a snapshot of the current workspace
 *   3. Runs validation with the detected command
 *   4. Returns the results
 *
 * Users who want manual control can just use the terminal directly.
 */
export function autoValidate(userId: string, taskId: string, raw: { idempotencyKey?: string; command?: string }) {
  uuid.parse(taskId);
  const idempotencyKey = raw.idempotencyKey ?? randomUUID();

  return asUser(userId, async db => {
    // 1. Get the task's latest run and workspace
    const task = (await db.query(
      `SELECT t.project_id, t.organization_id, r.id AS run_id, r.workspace_id
       FROM collab.tasks t
       LEFT JOIN collab.runs r ON r.task_id = t.id
       WHERE t.id = $1
       ORDER BY r.created_at DESC NULLS LAST
       LIMIT 1`,
      [taskId]
    )).rows[0];
    if (!task) throw new DomainError("not_found", "任务不存在或不可访问。", 404);
    if (!task.run_id) throw new DomainError("no_run", "还没有运行记录，无法验证。", 400);

    // 2. Get workspace checkout path to detect project type
    const workspace = (await db.query(
      "SELECT checkout_path FROM collab.workspaces WHERE id = $1",
      [task.workspace_id]
    )).rows[0];
    if (!workspace?.checkout_path) throw new DomainError("no_workspace", "找不到工作区。", 400);

    // 3. Detect test command (or use provided override)
    let tool: string, args: string[];
    if (raw.command) {
      const { parseQuickCommand } = await import("./validation-config");
      const parsed = parseQuickCommand(raw.command);
      tool = parsed.tool; args = parsed.args;
    } else {
      const detected = detectTestCommand(workspace.checkout_path);
      if (!detected) throw new DomainError("unknown_project_type", "无法自动检测项目类型，请手动指定测试命令。", 400);
      tool = detected.tool; args = detected.args;
    }

    // 4. Create snapshot
    const snapshot = (await db.query(
      "SELECT collab.create_snapshot($1, $2, $3) AS result",
      [task.run_id, `自动验证: ${describeTestCommand({ tool, args })}`, idempotencyKey]
    )).rows[0].result;
    const snapshotId = snapshot.snapshotId ?? snapshot.id;

    // 5. Create ephemeral validation profile and run
    const { requestQuickValidation } = await import("./validations");
    const command = [tool, ...args].join(" ");
    const result = await requestQuickValidation(userId, snapshotId, {
      command,
      idempotencyKey: randomUUID(),
    });

    return {
      ...result,
      snapshotId,
      command: describeTestCommand({ tool, args }),
      message: `已自动创建快照并运行 ${describeTestCommand({ tool, args })}`,
    };
  });
}
