import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { resolutionInputSchema, type ResolutionInput } from "../resolution-schema";
import { safeSnapshotPath } from "../snapshot-paths";

const INPUT_LIMIT = 1024 * 1024;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export function canonicalResolutionInput(raw: ResolutionInput) {
  const input = resolutionInputSchema.parse(raw);
  if (input.conflict.files.some(file => !safeSnapshotPath(file.path))) throw new Error("integration_resolution_input_invalid");
  const bytes = JSON.stringify(input);
  if (Buffer.byteLength(bytes) > INPUT_LIMIT) throw new Error("integration_resolution_input_limit");
  return { input, bytes, inputHash: hash(bytes) };
}
async function durable(file: string, bytes: string) {
  const handle = await open(file, "wx", 0o444);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  const directory = await open(path.dirname(file), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

export async function materializeResolutionInputs(workspaceRoot: string, raw: ResolutionInput | null) {
  if (raw) await durable(path.join(workspaceRoot, "resolution.json"), canonicalResolutionInput(raw).bytes);
}

/** Compare against caller-held canonical input, not a self-reported hash from
 * the agent's directory. Read-only mode alone is not a native trust boundary. */
export async function verifyResolutionInputs(workspaceRoot: string, raw: ResolutionInput | null) {
  const expected = raw ? canonicalResolutionInput(raw) : null;
  let handle;
  try { handle = await open(path.join(workspaceRoot, "resolution.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (!expected && (error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  try {
    if (!expected) throw new Error("snapshot_resolution_input_invalid");
    const before = await handle.stat();
    if (!before.isFile() || before.size > INPUT_LIMIT) throw new Error("snapshot_resolution_input_invalid");
    // Bound the read itself as well as the stat check: a writer can grow a
    // regular file after fstat, so readFile followed by a size check is too late.
    const buffer = Buffer.alloc(INPUT_LIMIT + 1); let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const bytes = buffer.subarray(0, length), after = await handle.stat();
    if (bytes.length > INPUT_LIMIT || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || !bytes.equals(Buffer.from(expected.bytes))) throw new Error("snapshot_resolution_input_changed");
  } finally { await handle.close(); }
  return expected!.inputHash;
}
