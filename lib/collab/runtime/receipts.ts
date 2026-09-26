import { sessionProcesses } from "./process-session";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { WorkspaceLocation } from "./workspace";

const exec = promisify(execFile);
export interface LaunchIdentity { runId: string; executorId: string; epoch: string }
const identitySchema = z.object({ runId: z.uuid(), executorId: z.uuid(), epoch: z.string().regex(/^[1-9][0-9]*$/) });
const receiptSchema = z.object({
  version: z.literal(1), workspaceId: z.uuid(), identity: identitySchema.nullable(),
  bootId: z.string().min(16).max(128), state: z.enum(["launching", "started", "stopped"]),
  terminalSession: z.number().int().min(2).optional(),
  pid: z.number().int().min(2).nullable(), updatedAt: z.string().datetime(),
}).strict();
type Receipt = z.infer<typeof receiptSchema>;
export type ExitEvidence = {
  safe: boolean;
  code: "stop_confirmed" | "group_absent" | "writer_present" | "receipt_missing" | "receipt_invalid" | "launch_uncertain" | "boot_changed" | "inspection_unavailable";
  receiptHash?: string;
};

// No command arguments, paths, credentials or process environment are returned to the UI.
async function bootId() {
  if (process.platform === "darwin") return (await exec("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], { timeout: 3000 })).stdout.trim();
  if (process.platform === "linux") return (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  throw new Error("Native recovery requires a supported boot identity");
}
export { bootId as nativeBootId };
function filename(root: string, workspaceId: string) {
  z.uuid().parse(workspaceId);
  return path.join(root, "runtime-receipts", `${workspaceId}.json`);
}
async function syncDirectory(directory: string) {
  const handle = await open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}
async function replace(file: string, receipt: Receipt) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(receipt)); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, file); await syncDirectory(path.dirname(file));
  } finally { await rm(temporary, { force: true }); }
}

/** Written before spawning. A crash in the launch gap deliberately remains ambiguous. */
export async function beginNativeReceipt(workspace: WorkspaceLocation, identity?: LaunchIdentity) {
  const file = filename(path.dirname(path.dirname(workspace.root)), workspace.id);
  const receipt: Receipt = receiptSchema.parse({ version: 1, workspaceId: workspace.id, identity: identity ?? null, bootId: await bootId(), state: "launching", pid: null, updatedAt: new Date().toISOString() });
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const handle = await open(file, "wx", 0o600); // A workspace can be launched only once, even across restarts.
  try { await handle.writeFile(JSON.stringify(receipt)); await handle.sync(); } finally { await handle.close(); }
  await syncDirectory(path.dirname(file));
  const update = async (state: Receipt["state"], pid: number | null) => {
    receipt.state = state; receipt.pid = pid; receipt.updatedAt = new Date().toISOString();
    await replace(file, receipt);
  };
  return {
    pendingSession: () => update("launching", receipt.pid),
    started: (pid: number, terminalSession?: number) => { if (terminalSession !== undefined) receipt.terminalSession=terminalSession; return update("started", pid); },
    stopped: () => update("stopped", receipt.pid),
  };
}

/** Read-only recovery. Never send a signal using a PID from disk. */
export async function inspectNativeExit(root: string, workspaceId: string, identity: LaunchIdentity): Promise<ExitEvidence> {
  let raw: string;
  try { raw = await readFile(filename(root, workspaceId), "utf8"); }
  catch (error) { return { safe: false, code: (error as NodeJS.ErrnoException).code === "ENOENT" ? "receipt_missing" : "inspection_unavailable" }; }
  let receipt: Receipt;
  try {
    if (raw.length > 4096) throw new Error("Oversized receipt");
    receipt = receiptSchema.parse(JSON.parse(raw));
    if (receipt.workspaceId !== workspaceId || !receipt.identity || Object.entries(identity).some(([key, value]) => receipt.identity![key as keyof LaunchIdentity] !== value)) throw new Error("Receipt identity mismatch");
  } catch { return { safe: false, code: "receipt_invalid" }; }
  const receiptHash = createHash("sha256").update(raw).digest("hex");
  if (receipt.state === "stopped") return { safe: true, code: "stop_confirmed", receiptHash };
  if (receipt.state === "launching" || !receipt.pid) return { safe: false, code: "launch_uncertain", receiptHash };
  try {
    // A boot mismatch may also mean that a data directory was copied to another node.
    // Do not assume that the original machine or writer is gone.
    if (receipt.bootId !== await bootId()) return { safe: false, code: "boot_changed", receiptHash };
    const exists = (pid: number) => {
      try { process.kill(pid, 0); return true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
    };
    if (receipt.terminalSession && (await sessionProcesses(receipt.terminalSession)).length) return { safe:false,code:"writer_present",receiptHash };
    if (exists(receipt.pid) || exists(-receipt.pid)) return { safe: false, code: "writer_present", receiptHash };
    return { safe: true, code: "group_absent", receiptHash };
  } catch { return { safe: false, code: "inspection_unavailable", receiptHash }; }
}
