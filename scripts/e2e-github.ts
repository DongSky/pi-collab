import assert from "node:assert/strict";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Pool } from "pg";
import { z } from "zod";
import { localConfig, connectionString } from "./local-config";
import { registerGitHubInstallation, bindGitHubRepository } from "../lib/collab/git/github-registration";
import { syncGitHubRepository } from "../lib/collab/git/github-sync";
import { importGitHubRepository } from "../lib/collab/git/github-import";
import { config as githubConfig, githubFixture } from "../tests/collab/fixtures/github";
import { githubGitFixture } from "../tests/collab/fixtures/github-git";
const dbName = process.env.PI_COLLAB_E2E_DATABASE ?? "", root = process.env.PI_COLLAB_E2E_DATA ?? "";
if (!/^pi_collab_test_[a-f0-9]+$/.test(dbName) || !path.basename(root).startsWith("identity-e2e-")) throw new Error("Isolated GitHub fixture required");
const admin = new Pool({ connectionString: connectionString(await localConfig(), true, dbName) }), fixture = await githubFixture(), master = randomBytes(32);
try {
  const repositoryId = z.uuid().parse(process.argv[2]);
  const repository = (await admin.query("SELECT r.*,p.created_by AS actor FROM collab.repositories r JOIN collab.projects p ON p.id=r.project_id WHERE r.id=$1", [repositoryId])).rows[0]; assert.ok(repository);
  fixture.state.branch = repository.default_branch; fixture.state.sha = repository.base_sha;
  const connection = await registerGitHubInstallation(admin, master, { ...githubConfig, organizationId: repository.organization_id, actorId: repository.actor, reason: "Isolated protocol fixture for GitHub connection UI", idempotencyKey: randomUUID() }, fixture.pem, fixture.transport);
  await bindGitHubRepository(admin, master, { repositoryId, connectionId: connection.connectionId, githubRepositoryId: "1011", actorId: repository.actor, reason: "Verify matching imported base and narrow repository read scope", idempotencyKey: randomUUID() }, fixture.transport);
  const serveRoot = path.join(root, "github-http-fixture"); await mkdir(serveRoot, { mode: 0o700 });
  await promisify(execFile)("git", ["-c", "core.hooksPath=/dev/null", "clone", "--bare", "--no-local", path.join(root, "repositories", repositoryId, "git"), path.join(serveRoot, "source.git")], { timeout: 30000 });
  const remote = await githubGitFixture(serveRoot, 1012);
  try {
    remote.api.state.sha = repository.base_sha; remote.api.state.branch = repository.default_branch; remote.api.state.name = "imported-repo";
    const imported = await importGitHubRepository(admin, root, master, { projectId: repository.project_id, actorId: repository.actor, connectionId: connection.connectionId, githubRepositoryId: "1012", name: "GitHub 真实导入仓库", reason: "Verify real smart HTTP import and shared browser visibility", idempotencyKey: randomUUID() }, { transport: remote.transport });
    const git = async (...args: string[]) => (await promisify(execFile)("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: path.join(serveRoot, "source.git"), timeout: 30000 })).stdout.trim();
    const tree = await git("rev-parse", `${imported.baseSha}^{tree}`);
    const advanced = await git("-c", "user.name=Remote collaborator", "-c", "user.email=remote@test.invalid", "commit-tree", tree, "-p", imported.baseSha, "-m", "Remote collaborator checkpoint");
    await git("update-ref", `refs/heads/${imported.defaultBranch}`, advanced); remote.api.state.sha = advanced;
    const synced = await syncGitHubRepository(admin, root, master, { repositoryId: imported.id, actorId: repository.actor, reason: "Verify safe fast-forward with shared browser baseline and history", idempotencyKey: randomUUID() }, { transport: remote.transport });
    assert.equal(synced.outcome, "fast_forward"); assert.equal(synced.remoteSha, advanced);
    const browserSha = await git("-c", "user.name=Remote collaborator", "-c", "user.email=remote@test.invalid", "commit-tree", tree, "-p", advanced, "-m", "Ready for browser sync request");
    await git("update-ref", `refs/heads/${imported.defaultBranch}`, browserSha);
    await writeFile(path.join(root, "github-fixture-master.key"), master, { mode: 0o600, flag: "wx" });
    await writeFile(path.join(root, "github-fixture.pem"), fixture.pem, { mode: 0o600, flag: "wx" });
    await writeFile(path.join(root, "github-fixture.json"), JSON.stringify({ branch: imported.defaultBranch, sha: browserSha }), { mode: 0o600, flag: "wx" });
    console.log(JSON.stringify({ browserSha, connectionId: connection.connectionId, organizationId: repository.organization_id, projectId: repository.project_id, repositoryId, imported, synced, providerFixture: true }));
  } finally { await remote.close(); }
} finally { master.fill(0); fixture.pem.fill(0); await fixture.close(); await admin.end(); }
