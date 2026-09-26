import { readFile } from "node:fs/promises";
import path from "node:path";
import { ExecutionStore } from "../../../lib/collab/execution-store";
import { executeValidation } from "../../../lib/collab/validation-worker";
import type { ValidationClaim } from "../../../lib/collab/runtime/validation";

process.once("message", async (input: { connection: string; claim: ValidationClaim; root: string }) => {
  const store = new ExecutionStore(input.connection);
  const watcher = setInterval(() => {
    void readFile(path.join(input.root, "workspaces", input.claim.id, "home", "started"), "utf8").then(value => {
      clearInterval(watcher); process.send?.({ ready: true, pid: Number(value.trim()) });
    }).catch(() => {});
  }, 25);
  try { await executeValidation(store, input.claim, input.root, undefined, 60000); }
  finally { clearInterval(watcher); await store.close(); process.disconnect?.(); }
});
