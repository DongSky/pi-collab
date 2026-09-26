import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { ReviewGit } from "../../lib/collab/runtime/review-git";
import { runnerEnvironment } from "../../lib/collab/runtime/workspace";

const exec = promisify(execFile);
async function fixture(t: TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "pi-collab-reader-race-"))), repository = path.join(root, "repositories", "git");
  await fs.mkdir(path.dirname(repository));
  const env = runnerEnvironment(root, root);
  await exec("git", ["init", "--bare", "--template=", "--object-format=sha1", repository], { env });
  const bytes = Buffer.from("independently verified content\n"), source = path.join(root, "content");
  await fs.writeFile(source, bytes);
  const id = (await exec("git", [`--git-dir=${repository}`, "hash-object", "-w", source], { env })).stdout.trim();
  t.after(async () => { t.mock.restoreAll(); syncBuiltinESMExports(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, repository, bytes, id, open: (signal = new AbortController().signal) => ReviewGit.open(root, ["repositories", "git"], signal) };
}

// Move real files exactly after enumeration, immediately before lstat. This
// reproduces index-pack's race without relying on scheduler timing or load.
function beforeStat(t: TestContext, file: string, action: () => Promise<void>) {
  const original = fs.lstat;
  t.mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
    if (args[0] === file) await action();
    return original(...args);
  });
  syncBuiltinESMExports();
}

test("review reader rescans a renamed Git pack temporary file and still verifies actual objects", async t => {
  const f = await fixture(t), temporary = path.join(f.repository, "objects/pack/tmp_rev_ABC123");
  await fs.writeFile(temporary, "temporary metadata"); let moves = 0;
  beforeStat(t, temporary, async () => { moves++; await fs.rename(temporary, path.join(f.root, "published-metadata")); });
  const reader = await f.open();
  assert.equal(moves, 1); assert.deepEqual((await reader.objects([f.id], "blob")).get(f.id), f.bytes);
});

test("review rescan rejects newly visible symbolic links and alternates", async t => {
  for (const kind of ["symlink", "alternates", "http-alternates"]) {
    const f = await fixture(t), temporary = path.join(f.repository, "objects/pack/tmp_pack_ABC123");
    await fs.writeFile(temporary, "temporary");
    beforeStat(t, temporary, async () => {
      await fs.rm(temporary);
      if (kind === "symlink") await fs.symlink(f.root, path.join(f.repository, "objects/pack/replacement"));
      else await fs.writeFile(path.join(f.repository, "objects/info", kind), f.root);
    });
    await assert.rejects(f.open(), /integration_code_unavailable/);
    t.mock.restoreAll(); syncBuiltinESMExports();
  }
});

test("review rescan revalidates ancestor identity and refuses replaced directories", async t => {
  const f = await fixture(t), temporary = path.join(f.repository, "objects/pack/tmp_idx_ABC123");
  await fs.writeFile(temporary, "temporary");
  beforeStat(t, temporary, async () => {
    const ancestor = path.dirname(f.repository);
    await fs.rm(temporary); await fs.rename(ancestor, ancestor + "-old");
    await fs.cp(ancestor + "-old", ancestor, { recursive: true });
  });
  await assert.rejects(f.open(), /integration_code_unavailable/);
});

test("review reader never retries arbitrary missing files or missing repository paths", async t => {
  const f = await fixture(t), file = path.join(f.repository, "config"); let calls = 0;
  beforeStat(t, file, async () => { calls++; await fs.rm(file); });
  await assert.rejects(f.open(), { code: "ENOENT" }); assert.equal(calls, 1);
  await fs.rename(f.repository, f.repository + "-old");
  await assert.rejects(f.open(), { code: "ENOENT" });
});

test("review metadata rescans are bounded under continuous temporary file churn", async t => {
  const f = await fixture(t), temporary = path.join(f.repository, "objects/pack/tmp_rev_ABC123");
  await fs.writeFile(temporary, "temporary"); let calls = 0;
  const original = fs.lstat;
  t.mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
    if (args[0] !== temporary) return original(...args);
    calls++; await fs.rm(temporary);
    try { return await original(...args); }
    finally { await fs.writeFile(temporary, "next temporary"); }
  });
  syncBuiltinESMExports();
  await assert.rejects(f.open(), /integration_code_unavailable/); assert.equal(calls, 3);
});

test("review reader honors cancellation before opening and between metadata scans", async t => {
  const f = await fixture(t), controller = new AbortController(), temporary = path.join(f.repository, "objects/pack/tmp_pack_ABC123");
  await fs.writeFile(temporary, "temporary"); let calls = 0;
  beforeStat(t, temporary, async () => { calls++; await fs.rm(temporary); controller.abort(); });
  await assert.rejects(f.open(controller.signal), /integration_code_unavailable/); assert.equal(calls, 1);
  await assert.rejects(f.open(controller.signal), /integration_code_unavailable/);
});
