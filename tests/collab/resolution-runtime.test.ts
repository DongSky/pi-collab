import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod, symlink, readdir } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { integrate } from "../../lib/collab/runtime/integration";
import { prepareResolutionWorkspace, verifyResolutionInputs } from "../../lib/collab/runtime/resolution";
import { createWorkspace, runnerEnvironment } from "../../lib/collab/runtime/workspace";
import { captureSnapshot } from "../../lib/collab/runtime/snapshots";
import { materializeContractInputs } from "../../lib/collab/runtime/contract-inputs";
import { NativeRuntimeBackend } from "../../lib/collab/runtime/backends";
import type { IntegrationClaim, IntegrationSource } from "../../lib/collab/integration-schema";
import type { ResolutionInput } from "../../lib/collab/resolution-schema";
import type { ContractPin } from "../../lib/collab/contract-schema";

const exec = promisify(execFile), root = await mkdtemp(path.join(tmpdir(), "pi-collab-resolution-"));
const original = path.join(root, "original"), repositoryId = randomUUID(), repository = path.join(root, "repositories", repositoryId, "git");
const signal = () => new AbortController().signal;
const git = async (cwd: string, args: string[]) => (await exec("git", args, { cwd, env: runnerEnvironment("/nonexistent", "/nonexistent") })).stdout;
let baseSha: string;
before(async () => {
  await mkdir(original);
  await git(original, ["init"]); await git(original, ["config", "user.name", "Resolution test"]); await git(original, ["config", "user.email", "resolution@test.invalid"]);
  for (const file of ["code.txt", "delete.txt", "rename.txt"]) await writeFile(path.join(original, file), `baseline ${file}\n`);
  await writeFile(path.join(original, "binary.bin"), Buffer.from([0, 1, 2, 3]));
  await writeFile(path.join(original, ".env"), "PRIVATE_FIXTURE=unchanged\n");
  await git(original, ["add", "."]); await git(original, ["commit", "-m", "Baseline"]); baseSha = (await git(original, ["rev-parse", "HEAD"])).trim();
  await mkdir(path.dirname(repository), { recursive: true }); await git(original, ["clone", "--no-local", "--", original, repository]);
});
after(async () => { await rm(root, { recursive: true, force: true }); });

async function source(files: Record<string, string | Buffer | null>, dependencies: IntegrationSource[] = [], contracts: ContractPin[] = [], change?: (checkout: string) => Promise<void>) {
  const workspace = await createWorkspace(root, randomUUID(), repository, baseSha, true);
  for (const [file, bytes] of Object.entries(files)) {
    const target = path.join(workspace.checkout, file);
    if (bytes === null) await rm(target); else { await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, bytes); }
  }
  await change?.(workspace.checkout); await materializeContractInputs(workspace.root, contracts);
  const saved = await captureSnapshot(root, { id: randomUUID(), runId: randomUUID(), workspaceId: workspace.id, repositoryId, baseSha,
    note: "Resolution source", context: { title: "Source", description: "", acceptance: "", prompt: "", status: "completed" }, contracts });
  const input: IntegrationSource = { resultId: randomUUID(), taskId: randomUUID(), snapshotId: saved.manifest.id, manifestHash: saved.manifestHash,
    worktreeCommit: saved.manifest.worktreeCommit, baseSha, dependencyResultIds: dependencies.map(source => source.resultId) };
  return { input, workspace, saved };
}
async function failure(sources: IntegrationSource[]) {
  const claim: IntegrationClaim = { id: randomUUID(), executorId: randomUUID(), epoch: "1", repositoryId, targetBranch: "main", targetSha: baseSha,
    inputHash: createHash("sha256").update(JSON.stringify(sources)).digest("hex"), profileId: randomUUID(), checkId: randomUUID(),
    config: { version: 1, steps: [{ tool: "node", args: ["-e", "process.exit(0)"], timeoutSeconds: 10 }] }, sources };
  const evidence = await integrate(root, claim, signal(), async () => { assert.fail("Conflicted previews cannot start checks"); });
  assert.equal(evidence.outcome, "conflicted"); assert.ok(evidence.conflict);
  const input: ResolutionInput = { version: 1, taskId: randomUUID(), integrationId: claim.id, inputHash: claim.inputHash, repositoryId,
    targetBranch: claim.targetBranch, targetSha: baseSha, profileId: claim.profileId, policyId: randomUUID(), sources,
    merges: evidence.merges, conflict: evidence.conflict };
  return { input, evidence };
}
async function pair() {
  const a = await source({ "shared.txt": "left\n" }), b = await source({ "shared.txt": "right\n" });
  return { a, b, ...await failure([a.input, b.input]) };
}
const absent = async (file: string) => assert.rejects(readFile(file), /ENOENT/);

test("resolution reconstruction consumes every pinned result after the first conflict and retains each later conflict", async () => {
  const a = await source({ "shared.txt": "first\n", "a.txt": "a\n" }, [], [], checkout => chmod(path.join(checkout, "shared.txt"), 0o755));
  const b = await source({ "shared.txt": "second\n", "b.txt": "b\n" });
  const c = await source({ "c.txt": "after first conflict\n" }, [b.input]);
  const d = await source({ "shared.txt": "third\n", "d.txt": "after second conflict\n" });
  const { input, evidence: originalEvidence } = await failure([a.input, b.input, c.input, d.input]);
  const prepared = await prepareResolutionWorkspace(root, randomUUID(), input, signal()), { workspace, evidence } = prepared;
  assert.equal(evidence.status, "requires_resolution"); assert.equal(evidence.merges.length, 4);
  assert.deepEqual(evidence.conflicts.map(conflict => conflict.resultId), [b.input.resultId, d.input.resultId]);
  assert.equal(evidence.conflicts[0].files[0].ours?.mode, "100755"); assert.equal(evidence.conflicts[0].files[0].theirs?.mode, "100644");
  for (const [file, text] of [["a.txt", "a\n"], ["b.txt", "b\n"], ["c.txt", "after first conflict\n"], ["d.txt", "after second conflict\n"]]) assert.equal(await readFile(path.join(workspace.checkout, file), "utf8"), text);
  const unresolved = await readFile(path.join(workspace.checkout, "shared.txt"), "utf8");
  for (const text of ["first", "second", "third", "<<<<<<<", ">>>>>>>"]) assert.ok(unresolved.includes(text));
  assert.equal(await git(workspace.checkout, ["status", "--porcelain"]), "", "A clean temporary index must still be marked requires_resolution");
  assert.equal(await verifyResolutionInputs(workspace.root, input), evidence.resolutionInputHash);
  for (const source of [a, b, c, d]) assert.equal((await git(source.workspace.checkout, ["rev-parse", "HEAD"])).trim(), baseSha);
  assert.equal(await readFile(path.join(a.workspace.checkout, "shared.txt"), "utf8"), "first\n");
  for (const checkout of [original, repository, path.join(root, "workspaces", input.integrationId, "checkout")]) assert.equal((await git(checkout, ["rev-parse", "HEAD"])).trim(), baseSha);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, "integrations", input.integrationId, "evidence.json"), "utf8")), originalEvidence);
  assert.equal(await git(workspace.checkout, ["remote"]), "");
});

test("fixed snapshots produce the same provisional commit in two workspaces despite later source edits", async () => {
  const { a, b, input } = await pair();
  const first = await prepareResolutionWorkspace(root, randomUUID(), input, signal());
  await writeFile(path.join(a.workspace.checkout, "shared.txt"), "mutable latest version\n");
  await git(b.workspace.checkout, ["add", "shared.txt"]);
  await git(b.workspace.checkout, ["commit", "-am", "Later unshared history"]);
  const second = await prepareResolutionWorkspace(root, randomUUID(), input, signal());
  assert.notEqual(first.workspace.id, second.workspace.id);
  assert.equal(first.evidence.preparedCommit, second.evidence.preparedCommit);
  assert.deepEqual(first.evidence.conflicts, second.evidence.conflicts);
  assert.equal(first.evidence.resolutionInputHash, second.evidence.resolutionInputHash);
  assert.equal((await readFile(path.join(second.workspace.checkout, "shared.txt"), "utf8")).includes("mutable latest"), false);
});

test("modify/delete, binary and rename conflicts preserve missing sides, exact stage bytes and structured kinds", async () => {
  const renamed = "baseline rename.txt\n";
  const a = await source({ "delete.txt": "modified\n", "binary.bin": Buffer.from([0, 9, 8]), "rename.txt": null, "left.txt": renamed });
  const b = await source({ "delete.txt": null, "binary.bin": Buffer.from([0, 7, 6]), "rename.txt": null, "right.txt": renamed });
  const tail = await source({ "tail.txt": "still included\n" });
  const { input } = await failure([a.input, b.input, tail.input]);
  const { workspace, evidence } = await prepareResolutionWorkspace(root, randomUUID(), input, signal());
  const conflict = evidence.conflicts[0], deleted = conflict.files.find(file => file.path === "delete.txt")!;
  assert.ok(deleted.base); assert.ok(deleted.ours); assert.equal(deleted.theirs, null);
  const binary = conflict.files.find(file => file.path === "binary.bin")!; assert.ok(binary.base && binary.ours && binary.theirs);
  for (const [side, expected] of [[binary.base, [0, 1, 2, 3]], [binary.ours, [0, 9, 8]], [binary.theirs, [0, 7, 6]]] as const) {
    const actual = await exec("git", ["cat-file", "blob", side.oid], { cwd: workspace.checkout, encoding: "buffer" });
    assert.deepEqual(actual.stdout, Buffer.from(expected));
  }
  assert.ok(conflict.notices.some(notice => notice.kind.includes("binary")));
  assert.ok(conflict.notices.some(notice => notice.kind.includes("rename/rename") && notice.paths.includes("left.txt") && notice.paths.includes("right.txt")));
  assert.equal(evidence.status, "requires_resolution"); assert.equal(await readFile(path.join(workspace.checkout, "tail.txt"), "utf8"), "still included\n");
});

test("reconstruction checks the original conflict and completed prefix before making a workspace available", async () => {
  const { input } = await pair();
  for (const changed of [
    { ...input, conflict: { ...input.conflict, files: input.conflict.files.map(file => ({ ...file, ours: "f".repeat(40) })) } },
    { ...input, merges: input.merges.map(merge => ({ ...merge, tree: "e".repeat(40) })) },
  ]) {
    const id = randomUUID(); await assert.rejects(prepareResolutionWorkspace(root, id, changed, signal()), /integration_resolution_mismatch/);
    await absent(path.join(root, "workspaces", id, "resolution.json"));
  }
});

test("a claimed conflict that no longer reproduces cannot be silently converted into a ready repair", async () => {
  const { a, input } = await pair(), clean = await source({ "shared.txt": "left\n" });
  const changed = { ...input, sources: [a.input, { ...clean.input, resultId: input.sources[1].resultId, taskId: input.sources[1].taskId }] };
  const id = randomUUID(); await assert.rejects(prepareResolutionWorkspace(root, id, changed, signal()), /integration_resolution_mismatch/);
  await absent(path.join(root, "workspaces", id, "resolution.json"));
});

test("later source bytes and executable mode survive preparation without a second Git encoding conversion", async () => {
  const { a, b } = await pair(), utf16 = Buffer.from("fixed UTF16\r\n", "utf16le"), crlf = Buffer.from("fixed CRLF\r\n");
  const c = await source({ ".gitattributes": "utf16.txt working-tree-encoding=UTF-16LE\nlines.txt text eol=lf\n", "utf16.txt": utf16, "lines.txt": crlf, "script.sh": "#!/bin/sh\nexit 0\n" }, [], [], checkout => chmod(path.join(checkout, "script.sh"), 0o755));
  const { input } = await failure([a.input, b.input, c.input]); const { workspace } = await prepareResolutionWorkspace(root, randomUUID(), input, signal());
  assert.deepEqual(await readFile(path.join(workspace.checkout, "utf16.txt")), utf16);
  assert.deepEqual(await readFile(path.join(workspace.checkout, "lines.txt")), crlf);
  assert.match(await git(workspace.checkout, ["ls-files", "--stage", "script.sh"]), /^100755 /);
});

test("malformed order, duplicated tasks and unsafe conflict paths fail before provisioning", async () => {
  const { input } = await pair();
  const invalid = [
    { ...input, taskId: input.sources[0].taskId },
    { ...input, sources: [input.sources[0], { ...input.sources[1], taskId: input.sources[0].taskId }] },
    { ...input, sources: [{ ...input.sources[0], dependencyResultIds: [input.sources[1].resultId] }, input.sources[1]] },
    { ...input, sources: [input.sources[0], { ...input.sources[1], dependencyResultIds: [input.sources[0].resultId, input.sources[0].resultId] }] },
    { ...input, conflict: { ...input.conflict, files: [{ ...input.conflict.files[0], path: "../outside" }] } },
    { ...input, policyId: "" },
  ];
  for (const changed of invalid) {
    const id = randomUUID(); await assert.rejects(prepareResolutionWorkspace(root, id, changed, signal()));
    await assert.rejects(readdir(path.join(root, "workspaces", id)), /ENOENT/);
  }
});

test("mismatched identities and corrupted later input never produce a ready repair workspace", async () => {
  const { a, b } = await pair(), c = await source({ "late.txt": "immutable bytes\n" });
  const { input } = await failure([a.input, b.input, c.input]);
  const wrong = { ...input, sources: input.sources.map(item => item.resultId === c.input.resultId ? { ...item, worktreeCommit: "a".repeat(40) } : item) };
  let id = randomUUID(); await assert.rejects(prepareResolutionWorkspace(root, id, wrong, signal()), /integration_source_mismatch/);
  await absent(path.join(root, "workspaces", id, "resolution.json"));
  const entry = c.saved.manifest.worktree.find(entry => entry.path === "late.txt")!;
  await writeFile(path.join(root, "snapshots", c.input.snapshotId, "blobs", entry.hash), "corrupt bytes\n");
  id = randomUUID(); await assert.rejects(prepareResolutionWorkspace(root, id, input, signal()), /snapshot_invalid_artifact/);
  await absent(path.join(root, "workspaces", id, "resolution.json"));
});

test("contract inputs are pinned and conflicting versions after the first Git failure stop preparation", async () => {
  const body = JSON.stringify({ title: "API", format: "text", definition: "Shared API v1", compatibility: "initial", migrationGuide: "", mockJson: null });
  const pin: ContractPin = { contractId: randomUUID(), key: "api", revisionId: randomUUID(), version: 1, body, bodyHash: createHash("sha256").update(body).digest("hex") };
  const a = await source({ "shared.txt": "first\n" }, [], [pin]), b = await source({ "shared.txt": "second\n" }, [], [pin]);
  const c = await source({ "later.txt": "later\n" }, [], [{ ...pin, revisionId: randomUUID(), version: 2 }]);
  const { input } = await failure([a.input, b.input, c.input]); const id = randomUUID();
  await assert.rejects(prepareResolutionWorkspace(root, id, input, signal()), /integration_contract_mismatch/);
  await absent(path.join(root, "workspaces", id, "resolution.json"));
  const good = await failure([a.input, b.input]); const prepared = await prepareResolutionWorkspace(root, randomUUID(), good.input, signal());
  assert.deepEqual(prepared.contracts, [pin]); assert.deepEqual(JSON.parse(await readFile(path.join(prepared.workspace.root, "contracts.json"), "utf8")), [pin]);
});

test("canonical input verification detects altered policy, mutation, symlinks, special files and oversized data", async () => {
  const { input } = await pair(); const { workspace } = await prepareResolutionWorkspace(root, randomUUID(), input, signal());
  const file = path.join(workspace.root, "resolution.json"), bytes = await readFile(file);
  await assert.rejects(verifyResolutionInputs(workspace.root, { ...input, policyId: randomUUID() }), /snapshot_resolution_input_changed/);
  await chmod(file, 0o600); await writeFile(file, Buffer.from(" "+bytes.toString()));
  await assert.rejects(verifyResolutionInputs(workspace.root, input), /snapshot_resolution_input_changed/); await rm(file);
  await symlink(path.join(original, "code.txt"), file); await assert.rejects(verifyResolutionInputs(workspace.root, input)); await rm(file);
  await mkdir(file); await assert.rejects(verifyResolutionInputs(workspace.root, input), /snapshot_resolution_input_invalid/); await rm(file, { recursive: true });
  await exec("mkfifo", [file]); await assert.rejects(verifyResolutionInputs(workspace.root, input), /snapshot_resolution_input_invalid/); await rm(file);
  await writeFile(file, Buffer.alloc(1024 * 1024 + 1)); await assert.rejects(verifyResolutionInputs(workspace.root, input), /snapshot_resolution_input_invalid/);
  await writeFile(file, bytes); await verifyResolutionInputs(workspace.root, input);
});

test("cancelled preparation and repeated workspace IDs cannot replace an existing writer", async () => {
  const { input } = await pair(), cancelled = new AbortController(); cancelled.abort();
  const id = randomUUID(); await assert.rejects(prepareResolutionWorkspace(root, id, input, cancelled.signal), /integration_cancelled/);
  await assert.rejects(readdir(path.join(root, "workspaces", id)), /ENOENT/);
  const active = new AbortController(), partial = randomUUID();
  const work = prepareResolutionWorkspace(root, partial, input, active.signal); const timer = setTimeout(() => active.abort(), 10);
  try { await assert.rejects(work, /integration_cancelled/); } finally { clearTimeout(timer); }
  await absent(path.join(root, "workspaces", partial, "resolution.json"));
  const { workspace } = await prepareResolutionWorkspace(root, randomUUID(), input, signal());
  await writeFile(path.join(workspace.checkout, "shared.txt"), "active repair\n");
  await assert.rejects(prepareResolutionWorkspace(root, workspace.id, input, signal()), /EEXIST/);
  assert.equal(await readFile(path.join(workspace.checkout, "shared.txt"), "utf8"), "active repair\n");
});

test("a real native Pi process can inspect the pinned repair inputs and edit its own full combination", { timeout: 30_000 }, async () => {
  const { a, b } = await pair(), c = await source({ "later.txt": "must survive the repair\n" });
  const { input } = await failure([a.input, b.input, c.input]);
  const { workspace, evidence } = await prepareResolutionWorkspace(root, randomUUID(), input, signal());
  const agent = await new NativeRuntimeBackend().start(workspace);
  try {
    const result = await agent.peer.command("bash", { command: "node -e 'const fs=require(\"node:fs\"),a=require(\"node:assert/strict\");const p=JSON.parse(fs.readFileSync(\"../resolution.json\",\"utf8\"));a.equal(p.sources.length,3);a.equal(fs.readFileSync(\"later.txt\",\"utf8\"),\"must survive the repair\\n\");fs.writeFileSync(\"shared.txt\",\"reviewable repair\\n\");'" });
    assert.equal((result.data as { exitCode: number }).exitCode, 0);
  } finally { await agent.stop(); }
  assert.equal(await readFile(path.join(workspace.checkout, "shared.txt"), "utf8"), "reviewable repair\n");
  assert.equal(await readFile(path.join(a.workspace.checkout, "shared.txt"), "utf8"), "left\n");
  assert.equal(await readFile(path.join(b.workspace.checkout, "shared.txt"), "utf8"), "right\n");
  assert.equal(await verifyResolutionInputs(workspace.root, input), evidence.resolutionInputHash);
  assert.equal(evidence.status, "requires_resolution", "Agent edits alone must not create passed checks, publication or merge authority");
});
