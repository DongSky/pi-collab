import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ExecutionStore } from "../execution-store";
export type WorkspaceUsage = { bytes: number | null; error: "scan_limit" | "unavailable" | null };
/** Metadata only; no file contents, symlink targets or filenames leave the supervisor. */
export async function measureWorkspace(dataRoot: string, id: string, stopAfter = Number.MAX_SAFE_INTEGER, missingIsEmpty = false): Promise<WorkspaceUsage> {
  z.uuid().parse(id); return measureDirectory(path.join(dataRoot, "workspaces", id), stopAfter, missingIsEmpty);
}
export async function measureDirectory(root: string, stopAfter = Number.MAX_SAFE_INTEGER, missingIsEmpty = false): Promise<WorkspaceUsage> {
  const todo = [root], deadline = Date.now() + 5000;
  let bytes = 0, entries = 0;
  try {
    if (!(await lstat(root)).isDirectory() || (await lstat(root)).isSymbolicLink()) return { bytes: null, error: "unavailable" };
    const canonical = await realpath(root);
    while (todo.length) {
      if (++entries > 250000 || Date.now() > deadline) return { bytes, error: "scan_limit" };
      const current = todo.pop()!;
      let stat;
      try { stat = await lstat(current); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      if (stat.isSymbolicLink()) { bytes += stat.size; continue; }
      if (stat.isDirectory()) {
        const resolved = await realpath(current);
        if (resolved !== canonical && !resolved.startsWith(canonical + path.sep)) return { bytes, error: "unavailable" };
        for (const name of await readdir(current)) todo.push(path.join(current, name));
      } else if (stat.isFile()) bytes += stat.size;
      if (!Number.isSafeInteger(bytes)) return { bytes: null, error: "scan_limit" };
      if (bytes > stopAfter) return { bytes, error: null };
    }
    return { bytes, error: null };
  } catch (error) { if (missingIsEmpty && (error as NodeJS.ErrnoException).code === "ENOENT") return { bytes: 0, error: null }; return { bytes: null, error: "unavailable" }; }
}
export async function measureStoppedWorkspaces(store: ExecutionStore, root: string, runtime: "native" | "docker") {
  for (const row of await store.storageScanCandidates(runtime)) await store.recordWorkspaceUsage(row.id, row.epoch, await measureWorkspace(root, row.id, undefined, true));
}
