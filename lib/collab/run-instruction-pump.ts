import { terminalCommand } from "./terminal-schema";
import type { ExecutionStore } from "./execution-store";
import type { RpcPeer } from "./runtime/rpc-peer";

/** Durable one-shot delivery into the already-running Pi process. */
export function startInstructionPump(store: ExecutionStore, peer: RpcPeer, executor: string, run: string, epoch: string, signal: AbortSignal, uncertain: () => void, terminal=false) {
  let closed = false, work: Promise<void> | undefined, closing: Promise<void> | undefined;
  const poll = () => {
    if (closed || work || signal.aborted) return;
    work = (async () => {
      const item = await store.claimInstruction(executor, run, epoch);
      if (!item) return;
      if (closed || signal.aborted) { await store.finishInstruction(executor, run, epoch, item.id, "rejected"); return; }
      let outcome: "delivered" | "rejected" | "unknown" = "delivered";
      try {
        // Names and messages are project input, never system instructions. The
        // prefix prevents slash-command expansion and preserves human attribution.
        if(terminal){
          let command;try{command=terminalCommand.parse(JSON.parse(item.message));}catch{outcome="rejected";}
          if(command)await peer.command(command.type==="input"?"terminal_input":"terminal_resize",command,5000);
        }else await peer.command(item.kind, { message: `Team instruction (project input) from ${JSON.stringify(item.authorName)} [${item.authorId}], control version ${item.controlVersion}:\n${item.message}` }, 5000);
      } catch (error) { outcome = (error as { code?: string }).code === "PI_RPC_REJECTED" ? "rejected" : "unknown"; }
      const saved = await store.finishInstruction(executor, run, epoch, item.id, outcome);
      if (outcome === "unknown" || saved === "unknown") uncertain();
    })().catch(() => uncertain()).finally(() => { work = undefined; });
  };
  const timer = setInterval(poll, terminal ? 50 : 500);
  return { close() {
    return closing ??= (async () => {
      closed = true; clearInterval(timer);
      if (work) await work;
      try { await store.closeInstructionChannel(executor, run, epoch); } catch { if (!signal.aborted) uncertain(); }
    })();
  } };
}
