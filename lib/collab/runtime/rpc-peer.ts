import { randomUUID } from "node:crypto";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

export interface RpcResponse { id: string; type: "response"; command: string; success: boolean; data?: unknown; error?: string }
type Pending = { resolve: (result: RpcResponse) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
export class RpcOutcomeUnknown extends Error { readonly code = "PI_RPC_OUTCOME_UNKNOWN"; }
export class RpcRejected extends Error { readonly code = "PI_RPC_REJECTED"; }

/** Pi's protocol uses LF framing, not generic Unicode line separators. */
export class RpcPeer {
  private buffer = "";
  private pending = new Map<string, Pending>();
  private listeners = new Set<(event: Record<string, unknown>) => void>();
  private stderrTail = "";
  private closed = false;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;

  constructor(readonly child: ChildProcessWithoutNullStreams, private readonly internalEvent?: (event: Record<string, unknown>) => boolean) {
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consume(chunk));
    child.stderr.on("data", (chunk: string) => { this.stderrTail = (this.stderrTail + chunk).slice(-4096); });
    child.on("error", (error) => this.failAll(error));
    this.exited = new Promise(resolve => child.once("close", (code, signal) => {
      this.closed = true;
      this.failAll(new RpcOutcomeUnknown(`Pi process exited (${code ?? signal ?? "unknown"})`));
      resolve({ code, signal });
    }));
  }

  get pid() { return this.child.pid; }
  get alive() { return !this.closed && this.child.exitCode === null && this.child.signalCode === null; }
  diagnostics() { return this.stderrTail; }

  private consume(chunk: string) {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > 32 * 1024 * 1024) {
      this.failAll(new RpcOutcomeUnknown("Pi RPC frame exceeds 32 MiB"));
      this.child.kill("SIGTERM");
      return;
    }
    let end: number;
    while ((end = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, end).replace(/\r$/, "");
      this.buffer = this.buffer.slice(end + 1);
      if (!line) continue;
      let event: Record<string, unknown>;
      try { event = JSON.parse(line); }
      catch { this.failAll(new RpcOutcomeUnknown("Invalid JSON from Pi RPC")); this.child.kill("SIGTERM"); return; }
      if (this.internalEvent?.(event)) continue;
      if (event.type === "response" && typeof event.id === "string") {
        const request = this.pending.get(event.id);
        if (request) {
          clearTimeout(request.timer); this.pending.delete(event.id);
          if (event.success === true) request.resolve(event as unknown as RpcResponse);
          else request.reject(new RpcRejected(String(event.error ?? "Pi command failed")));
        }
      }
      for (const listener of this.listeners) {
        try { listener(event); } catch { /* One observer cannot break command delivery. */ }
      }
    }
  }

  private failAll(error: Error) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }

  command(type: string, payload: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<RpcResponse> {
    if (!this.alive) return Promise.reject(new Error("Pi process is not running"));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // Timeout does not mean the command failed; callers must reconcile side effects.
        reject(new RpcOutcomeUnknown(`Pi command ${type} timed out; outcome is unknown`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ ...payload, type, id }) + "\n", error => {
        if (error) { clearTimeout(timer); this.pending.delete(id); reject(new RpcOutcomeUnknown(error.message)); }
      });
    });
  }

  subscribe(listener: (event: Record<string, unknown>) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}
