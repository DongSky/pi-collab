import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { performWriteback, resolveBoundFilePath, runDocumentWriteback } = await jiti.import("./local-writeback.ts");
const { allowFileRoot } = await jiti.import("../allowed-roots.ts");

async function freshDir(t, prefix = "pi-wb-test-") {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function stubDb({ bindingRows = [], docStateRows = [], calls = [] } = {}) {
  return {
    query: async (text, params) => {
      calls.push({ text, params });
      if (text.includes("project_local_bindings")) return { rows: bindingRows };
      if (text.includes("document_writeback_state")) return { rows: docStateRows };
      return { rows: [] };
    },
  };
}

test("resolveBoundFilePath resolves a normal doc path inside the binding", async (t) => {
  const dir = await freshDir(t);
  assert.equal(resolveBoundFilePath(dir, "a/b.txt"), path.join(dir, "a/b.txt"));
});

test("resolveBoundFilePath rejects paths escaping the snapshot root", async (t) => {
  const dir = await freshDir(t);
  assert.throws(() => resolveBoundFilePath(dir, "../etc/passwd"));
  assert.throws(() => resolveBoundFilePath(dir, "a/../../escape.txt"));
});

test("resolveBoundFilePath rejects symlink escapes through a planted link", async (t) => {
  const dir = await freshDir(t);
  const outside = await freshDir(t, "pi-wb-outside-");
  await symlink(outside, path.join(dir, "link"));
  assert.throws(() => resolveBoundFilePath(dir, "link/secret.txt"));
});

test("performWriteback writes a new file on first write-back", async (t) => {
  const dir = await freshDir(t);
  const outcome = await performWriteback({
    bindingPath: dir, docPath: "new.txt", newContent: "hello", originalText: "", lastWritten: null,
  });
  assert.equal(outcome.status, "written");
  assert.equal(await readFile(path.join(dir, "new.txt"), "utf8"), "hello");
});

test("performWriteback reports in-sync when the disk already matches", async (t) => {
  const dir = await freshDir(t);
  await writeFile(path.join(dir, "same.txt"), "same");
  const outcome = await performWriteback({
    bindingPath: dir, docPath: "same.txt", newContent: "same", originalText: "same", lastWritten: null,
  });
  assert.equal(outcome.status, "in-sync");
});

test("performWriteback overwrites when the disk matches the last write", async (t) => {
  const dir = await freshDir(t);
  await writeFile(path.join(dir, "v.txt"), "v1");
  const outcome = await performWriteback({
    bindingPath: dir, docPath: "v.txt", newContent: "v2", originalText: "v0",
    lastWritten: Buffer.from("v1", "utf8"),
  });
  assert.equal(outcome.status, "written");
  assert.equal(await readFile(path.join(dir, "v.txt"), "utf8"), "v2");
});

test("performWriteback merges non-conflicting external edits", async (t) => {
  const dir = await freshDir(t);
  const base = "a\nb\nc\n";
  await writeFile(path.join(dir, "m.txt"), "a\nb\nC\n");
  const outcome = await performWriteback({
    bindingPath: dir, docPath: "m.txt", newContent: "A\nb\nc\n", originalText: base,
    lastWritten: Buffer.from(base, "utf8"),
  });
  assert.equal(outcome.status, "merged");
  assert.equal(await readFile(path.join(dir, "m.txt"), "utf8"), "A\nb\nC\n");
});

test("performWriteback conflicts when both sides changed the same line", async (t) => {
  const dir = await freshDir(t);
  const base = "base\n";
  await writeFile(path.join(dir, "c.txt"), "base\nexternal\n");
  const outcome = await performWriteback({
    bindingPath: dir, docPath: "c.txt", newContent: "base\nmine\n", originalText: base,
    lastWritten: Buffer.from(base, "utf8"),
  });
  assert.equal(outcome.status, "conflict");
  assert.equal(outcome.conflict.local, "base\nmine\n");
  assert.equal(outcome.conflict.remote, "base\nexternal\n");
  // The local file is left untouched for the user to resolve.
  assert.equal(await readFile(path.join(dir, "c.txt"), "utf8"), "base\nexternal\n");
});

test("performWriteback deletes a file it previously wrote", async (t) => {
  const dir = await freshDir(t);
  await writeFile(path.join(dir, "gone.txt"), "v1");
  const outcome = await performWriteback({
    bindingPath: dir, docPath: "gone.txt", newContent: null, originalText: "v0",
    lastWritten: Buffer.from("v1", "utf8"),
  });
  assert.equal(outcome.status, "deleted");
  await assert.rejects(readFile(path.join(dir, "gone.txt")), /ENOENT/);
});

test("performWriteback refuses to delete a file with external work", async (t) => {
  const dir = await freshDir(t);
  await writeFile(path.join(dir, "keep.txt"), "external work");
  const outcome = await performWriteback({
    bindingPath: dir, docPath: "keep.txt", newContent: null, originalText: "",
    lastWritten: null,
  });
  assert.equal(outcome.status, "conflict");
  assert.equal(await readFile(path.join(dir, "keep.txt"), "utf8"), "external work");
});

test("runDocumentWriteback returns needs-local-path for a pure shared draft", async () => {
  const out = await runDocumentWriteback(
    stubDb(), "00000000-0000-0000-0000-000000000000",
    { id: "d1", path: "a.txt", content: "x", original_text: "", local_path: null },
    { deleted: false },
  );
  assert.equal(out.status, "needs-local-path");
});

test("runDocumentWriteback returns unbound for a deleted pure draft", async () => {
  const out = await runDocumentWriteback(
    stubDb(), "00000000-0000-0000-0000-000000000000",
    { id: "d1", path: "a.txt", content: "", original_text: "", local_path: null },
    { deleted: true },
  );
  assert.equal(out.status, "unbound");
});

test("runDocumentWriteback prefers the user binding over a document path", async (t) => {
  const dir = await freshDir(t);
  const calls = [];
  const out = await runDocumentWriteback(
    stubDb({ bindingRows: [{ id: "b1", localPath: dir }], calls }),
    "00000000-0000-0000-0000-000000000000",
    { id: "d1", path: "doc.txt", content: "bound wins", original_text: "", local_path: "/elsewhere/doc.txt" },
    { deleted: false },
  );
  assert.equal(out.status, "written");
  assert.equal(out.scope, "binding");
  assert.equal(await readFile(path.join(dir, "doc.txt"), "utf8"), "bound wins");
  assert.ok(calls.some((c) => c.text.includes("record_local_writeback")));
});

test("runDocumentWriteback writes through a document-level local path and records the baseline", async (t) => {
  const dir = await freshDir(t);
  allowFileRoot(dir);
  const target = path.join(dir, "doc.txt");
  const calls = [];
  const out = await runDocumentWriteback(
    stubDb({ calls }),
    "00000000-0000-0000-0000-000000000000",
    { id: "d1", path: "doc.txt", content: "hello local", original_text: "", local_path: target },
    { deleted: false },
  );
  assert.equal(out.status, "written");
  assert.equal(out.scope, "document");
  assert.equal(out.localPath, target);
  assert.equal(await readFile(target, "utf8"), "hello local");
  assert.ok(calls.some((c) => c.text.includes("record_document_writeback")));
});

test("runDocumentWriteback rejects a document path outside the allowed roots", async () => {
  const out = await runDocumentWriteback(
    stubDb(), "00000000-0000-0000-0000-000000000000",
    { id: "d1", path: "doc.txt", content: "x", original_text: "", local_path: "/definitely/not/allowed/doc.txt" },
    { deleted: false },
  );
  assert.equal(out.status, "error");
});
