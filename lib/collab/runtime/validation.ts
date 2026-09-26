import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { release } from "node:os";
import path from "node:path";
import { z } from "zod";
import { findNodeCliScript } from "../../node-cli";
import { validationConfig, type ValidationConfig } from "../validation-config";
import { loadSnapshot, materializeDependencyInputs, restoreSnapshot, verifyDependencyInputs, verifySnapshotWorkingTree } from "./snapshots";
import type { DependencyPin } from "../dependency-inputs";
import type { ContractPin } from "../contract-schema";
import { materializeContractInputs, verifyContractInputs } from "./contract-inputs";
import { runnerEnvironment } from "./workspace";
import { resolutionInputSchema, type ResolutionInput } from "../resolution-schema";
import { materializeResolutionInputs, verifyResolutionInputs } from "./resolution-inputs";
import { assertResolutionMarkersAbsent } from "./resolution-markers";

const hash = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const OUTPUT_LIMIT = 1024 * 1024;
export interface ValidationClaim {
  revert?: boolean;
  runtime?: "native" | "docker";
  resolution?: ResolutionInput | null;
  id: string; executorId: string; epoch: string; snapshotId: string; manifestHash: string;
  repositoryId: string; profileId: string; config: ValidationConfig;
}
export interface StepEvidence {
  tool: "node" | "npm"; args: string[]; timeoutSeconds: number; exitCode: number | null; signal: string | null;
  startedAt: string; finishedAt: string; outputBytes: number; outputHash: string; hashedBytes: number; outputTruncated: boolean;
  error: string | null; cleanupConfirmed: boolean; sourceUnchanged: boolean;
}
export interface ValidationEvidence {
  revertMarkersAbsent?: boolean;
  resolution?: ResolutionInput;
  resolutionMarkersAbsent?: boolean;
  version: 1; validationId: string; snapshotId: string; manifestHash: string; worktreeCommit: string;
  profileId: string; configHash: string; config: ValidationConfig;
  dependencies: DependencyPin[];
  contracts: ContractPin[];
  environment: { image?: string; policy: string; node: string; nodeHash: string; npmCliHash: string | null; platform: string; arch: string; kernel: string };
  excludedCount: number; steps: StepEvidence[]; outcome: "passed" | "failed" | "cancelled" | "unknown";
}

async function durable(file: string, value: unknown) {
  const handle = await open(file, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
  for (const dir of [path.dirname(file), path.dirname(path.dirname(file))]) {
    const directory = await open(dir, "r"); try { await directory.sync(); } finally { await directory.close(); }
  }
}

async function runStep(step: ValidationConfig["steps"][number], args: string[], cwd: string, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<StepEvidence> {
  const startedAt = new Date().toISOString(), output = createHash("sha256");
  let bytes = 0, hashedBytes = 0, error: string | null = null, closed = false;
  let exitCode: number | null = null, exitSignal: string | null = null;
  const child = spawn(process.execPath, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const groupAlive = () => {
    if (!child.pid) return false;
    try { process.kill(-child.pid, 0); return true; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ESRCH") return false; throw e; }
  };
  const kill = (value: NodeJS.Signals) => {
    if (!child.pid) return;
    try { process.kill(-child.pid, value); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e; }
  };
  let wake!: () => void;
  const done = new Promise<void>(resolve => { wake = resolve; });
  const abort = (code: string) => { error ??= code; wake(); };
  const cancelled = () => abort("validation_cancelled");
  signal.addEventListener("abort", cancelled, { once: true });
  const timer = setTimeout(() => abort("validation_timeout"), step.timeoutSeconds * 1000);
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (data: Buffer) => {
    bytes += data.length;
    const keep = data.subarray(0, Math.max(0, OUTPUT_LIMIT - hashedBytes)); output.update(keep); hashedBytes += keep.length;
    if (bytes > OUTPUT_LIMIT) abort("validation_output_limit");
  });
  child.once("error", () => abort("validation_spawn_failed"));
  child.once("exit", (code, value) => { exitCode = code; exitSignal = value; wake(); });
  child.once("close", () => { closed = true; wake(); });
  if (signal.aborted) cancelled();
  let cleanupConfirmed = false;
  try {
    await done;
    // A successful parent exit with live tools is not a successful check.
    if (!error && groupAlive()) error = "validation_descendants_running";
    kill("SIGTERM");
    let deadline = Date.now() + 2000;
    while ((groupAlive() || !closed) && Date.now() < deadline) await pause(25);
    if (groupAlive()) kill("SIGKILL");
    deadline = Date.now() + 2000;
    while ((groupAlive() || !closed) && Date.now() < deadline) await pause(25);
    cleanupConfirmed = !groupAlive() && closed;
    if (!cleanupConfirmed) error = "validation_exit_unconfirmed";
    else if (exitCode !== 0) error ??= "validation_nonzero_exit";
  } finally {
    clearTimeout(timer); signal.removeEventListener("abort", cancelled);
    if (!closed) { child.stdout.destroy(); child.stderr.destroy(); }
  }
  return { ...step, exitCode, signal: exitSignal, startedAt, finishedAt: new Date().toISOString(), outputBytes: bytes, outputHash: output.digest("hex"), hashedBytes, outputTruncated: bytes > hashedBytes, error, cleanupConfirmed, sourceUnchanged: false };
}

/** Native trusted-code runner. No database/model credentials, no inherited HOME.
 * Exclusive execution directory means a restarted worker cannot replay commands.
 * Raw command output is deliberately not persisted or returned to browsers.
 */
export async function validateSnapshot(root: string, claim: ValidationClaim, signal: AbortSignal): Promise<ValidationEvidence> {
  if (claim.runtime === "docker") return (await import("./container-validation")).validateContainerSnapshot(root,claim,signal);
  if (!["darwin", "linux"].includes(process.platform)) throw new Error("validation_runtime_unsupported");
  z.uuid().parse(claim.id); z.uuid().parse(claim.executorId); z.uuid().parse(claim.profileId);
  const config = validationConfig.parse(claim.config), configHash = hash(JSON.stringify(config));
  const directory = path.join(root, "validation-executions", claim.id);
  await mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
  await mkdir(directory, { mode: 0o700 });
  await durable(path.join(directory, "admitted.json"), { id: claim.id, executorId: claim.executorId, epoch: claim.epoch, snapshotId: claim.snapshotId, manifestHash: claim.manifestHash, configHash });
  const { manifest, blobs } = await loadSnapshot(root, claim.snapshotId, claim.manifestHash);
  if (manifest.repositoryId !== claim.repositoryId) throw new Error("validation_source_mismatch");
  const resolution = claim.resolution ? resolutionInputSchema.parse(claim.resolution) : null;
  if (JSON.stringify(manifest.resolution) !== JSON.stringify(resolution) || (resolution && resolution.profileId !== claim.profileId)) throw new Error("snapshot_resolution_input_invalid");
  if (resolution || claim.revert) assertResolutionMarkersAbsent(manifest.worktree.map(entry => blobs.get(entry.hash)!));
  const workspace = await restoreSnapshot(root, claim.id, claim.snapshotId, claim.manifestHash);
  await materializeDependencyInputs(root, workspace.root, manifest.dependencies);
  await materializeContractInputs(workspace.root, manifest.contracts);
  await materializeResolutionInputs(workspace.root, resolution);
  const npm = config.steps.some(step => step.tool === "npm") ? findNodeCliScript("npm") : null;
  if (config.steps.some(step => step.tool === "npm") && !npm) throw new Error("validation_npm_unavailable");
  const evidence: ValidationEvidence = {
    version: 1, validationId: claim.id, snapshotId: claim.snapshotId, manifestHash: claim.manifestHash, worktreeCommit: manifest.worktreeCommit,
    profileId: claim.profileId, configHash, config, dependencies: manifest.dependencies, contracts: manifest.contracts,
    ...(resolution ? { resolution, resolutionMarkersAbsent: true } : {}),
    ...(claim.revert ? { revertMarkersAbsent: true } : {}),
    environment: { policy: "native-trusted-v1", node: process.version, nodeHash: hash(await readFile(process.execPath)), npmCliHash: npm ? hash(await readFile(npm)) : null,
      platform: process.platform, arch: process.arch, kernel: release() },
    excludedCount: manifest.excluded.length, steps: [], outcome: "passed",
  };
  const temp = path.join(workspace.root, "tmp"); await mkdir(temp, { mode: 0o700 });
  // npm refuses loading the same /dev/null path as both global and user config.
  const userConfig = path.join(workspace.home, "user.npmrc"), globalConfig = path.join(workspace.home, "global.npmrc");
  await writeFile(userConfig, "", { flag: "wx", mode: 0o600 }); await writeFile(globalConfig, "", { flag: "wx", mode: 0o600 });
  const env = { ...runnerEnvironment(workspace.home, workspace.agentDir), TMPDIR: temp, TMP: temp, TEMP: temp, CI: "1", TZ: "UTC",
    npm_config_cache: path.join(workspace.home, ".npm"), npm_config_userconfig: userConfig, npm_config_globalconfig: globalConfig, npm_config_update_notifier: "false" };
  for (const step of config.steps) {
    if (signal.aborted) { evidence.outcome = "cancelled"; break; }
    const result = await runStep(step, step.tool === "npm" ? [npm!, ...step.args] : step.args, workspace.checkout, env, signal);
    evidence.steps.push(result);
    if (!result.cleanupConfirmed) { evidence.outcome = "unknown"; break; }
    try { await verifySnapshotWorkingTree(workspace.checkout, manifest); await verifyDependencyInputs(root, workspace.root, manifest.dependencies); await verifyContractInputs(workspace.root, manifest.contracts); await verifyResolutionInputs(workspace.root, resolution); result.sourceUnchanged = true; }
    catch { result.error ??= "validation_source_changed"; }
    if (signal.aborted) { evidence.outcome = "cancelled"; break; }
    if (result.error) { evidence.outcome = "failed"; break; }
  }
  await durable(path.join(directory, "evidence.json"), evidence);
  return evidence;
}
