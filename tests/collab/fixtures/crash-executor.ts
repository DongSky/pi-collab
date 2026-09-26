import { ExecutionStore, type ClaimedRun } from "../../../lib/collab/execution-store";
import { executeClaim } from "../../../lib/collab/executor";
import { NativeRuntimeBackend } from "../../../lib/collab/runtime/backends";

// Test-only child supervisor. IPC/config never enter Pi's whitelisted environment.
process.once("message", async (input: { connection: string; executor: string; claim: ClaimedRun; root: string }) => {
  const store = new ExecutionStore(input.connection);
  try {
    await executeClaim(store, input.executor, input.claim, {
      dataRoot: input.root, backend: new NativeRuntimeBackend(), heartbeatMs: 60_000,
      driver: async agent => {
        await agent.peer.command("bash", { command: 'node -e \'require("fs").appendFileSync("once.txt","once\\n")\'' });
        const waiting = agent.peer.command("bash", { command: "sleep 120" }, 150_000);
        process.send?.({ ready: true, pid: agent.peer.pid });
        await waiting; return { kind: "crash-test" };
      },
    });
  } finally { await store.close(); process.disconnect?.(); }
});
