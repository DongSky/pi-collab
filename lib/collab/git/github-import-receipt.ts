import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, lstat, open, realpath, readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { GitHubError, readPrivateGitHubFile } from "./github-credentials";
import { githubBranch, type GitHubRepositoryEvidence } from "./github-schema";

export type ImportReceiptJob = { id: string; repository_id: string; project_id: string; connection_id: string; installation_version: string; github_repository_id: string };
const receiptMac = (master: Buffer, payload: string) => createHmac("sha256", master).update(`pi-collab:github-import:v1:${payload}`).digest();
export async function writeImportReceipt(directory: string, master: Buffer, job: ImportReceiptJob, evidence: GitHubRepositoryEvidence) {
  const payload = JSON.stringify({ version: 1, jobId: job.id, repositoryId: job.repository_id, projectId: job.project_id, connectionId: job.connection_id, installationVersion: job.installation_version, evidence });
  const handle = await open(path.join(directory, "import-ready.json"), "wx", 0o600);
  try { await handle.writeFile(JSON.stringify({ payload, mac: receiptMac(master, payload).toString("hex") })); await handle.sync(); } finally { await handle.close(); }
  const folder = await open(directory, "r"); try { await folder.sync(); } finally { await folder.close(); }
}
export async function readImportReceipt(directory: string, master: Buffer, job: ImportReceiptJob): Promise<GitHubRepositoryEvidence> {
  try {
    let files = 0, bytes = 0;
    const guard = async (dir: string) => { for (const name of await readdir(dir)) {
      const file = path.join(dir, name), info = await lstat(file);
      if (++files > 50000 || info.isSymbolicLink() || (!info.isDirectory() && (!info.isFile() || info.nlink !== 1)) || ["alternates", "http-alternates"].includes(name)) throw new Error();
      if (info.isDirectory()) await guard(file); else { bytes += info.size; if (bytes > 512 * 1024 * 1024) throw new Error(); }
    } }; await guard(directory);
    const wrapper = z.object({ payload: z.string().max(65536), mac: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(JSON.parse((await readPrivateGitHubFile(path.join(directory, "import-ready.json"), 131072)).toString()));
    if (!timingSafeEqual(receiptMac(master, wrapper.payload), Buffer.from(wrapper.mac, "hex"))) throw new Error();
    const result = JSON.parse(wrapper.payload);
    if (result.version !== 1 || result.jobId !== job.id || result.repositoryId !== job.repository_id || result.projectId !== job.project_id || result.connectionId !== job.connection_id || result.installationVersion !== job.installation_version || result.evidence.repositoryId !== job.github_repository_id || result.evidence.tokenRevoked !== true) throw new Error();
    githubBranch.parse(result.evidence.defaultBranch); z.string().regex(/^[a-f0-9]{40}$/).parse(result.evidence.targetSha);
    return result.evidence;
  } catch { throw new GitHubError("github_import_receipt_unavailable"); }
}
export async function importDirectory(root: string, job: ImportReceiptJob) {
  const canonical = await realpath(root), parent = path.join(canonical, "repositories"); await mkdir(parent, { recursive: true, mode: 0o700 });
  if ((await lstat(parent)).isSymbolicLink()) throw new GitHubError("github_import_path_invalid");
  return path.join(parent, z.uuid().parse(job.repository_id));
}
