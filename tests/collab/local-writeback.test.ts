import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performWriteback, resolveBoundFilePath, forceWriteback, type WritebackInput } from "../../lib/collab/local-writeback";

const dir = () => mkdtempSync(join(tmpdir(), "pi-writeback-"));
const input = (bindingPath: string, overrides: Partial<WritebackInput> = {}): WritebackInput => ({
 bindingPath, docPath: "src/app.ts", newContent: "saved\n", originalText: "original\n", lastWritten: null, ...overrides,
});

test("first write-back succeeds when disk matches import content or is missing", async () => {
 const root = dir();
 mkdirSync(join(root, "src"), { recursive: true });
 writeFileSync(join(root, "src", "app.ts"), "original\n");
 const a = await performWriteback(input(root));
 assert.equal(a.status, "written");
 assert.equal(readFileSync(join(root, "src", "app.ts"), "utf8"), "saved\n");
 const b = await performWriteback(input(root, { docPath: "new/file.ts", originalText: "" }));
 assert.equal(b.status, "written");
 assert.equal(readFileSync(join(root, "new", "file.ts"), "utf8"), "saved\n");
 rmSync(root, { recursive: true, force: true });
});

test("unchanged disk after a write-back reports in-sync without touching bytes", async () => {
 const root = dir();
 mkdirSync(join(root, "src"), { recursive: true });
 writeFileSync(join(root, "src", "app.ts"), "saved\n");
 const outcome = await performWriteback(input(root, { lastWritten: Buffer.from("saved\n") }));
 assert.equal(outcome.status, "in-sync");
 rmSync(root, { recursive: true, force: true });
});

test("non-overlapping external edit merges instead of overwriting", async () => {
 const root = dir();
 mkdirSync(join(root, "src"), { recursive: true });
 const baseline = "line1\nline2\nline3\nline4\nline5\nline6\nline7\n";
 writeFileSync(join(root, "src", "app.ts"), "line1\nline2\nline3\nline4\nline5\nline6-external\nline7\n");
 // Baseline we wrote; draft changes line1 only, disk changed line6 only: hunks don't overlap.
 const outcome = await performWriteback(input(root, {
  newContent: "line1-saved\nline2\nline3\nline4\nline5\nline6\nline7\n",
  originalText: baseline,
  lastWritten: Buffer.from(baseline),
 }));
 assert.equal(outcome.status, "merged");
 assert.equal(readFileSync(join(root, "src", "app.ts"), "utf8"), "line1-saved\nline2\nline3\nline4\nline5\nline6-external\nline7\n");
 rmSync(root, { recursive: true, force: true });
});

test("overlapping external edit becomes a conflict and leaves the disk untouched", async () => {
 const root = dir();
 mkdirSync(join(root, "src"), { recursive: true });
 writeFileSync(join(root, "src", "app.ts"), "theirs\n");
 const outcome = await performWriteback(input(root, {
  newContent: "mine\n", originalText: "base\n", lastWritten: Buffer.from("base\n"),
 }));
 assert.equal(outcome.status, "conflict");
 if (outcome.status === "conflict") {
  assert.equal(outcome.conflict.base, "base\n");
  assert.equal(outcome.conflict.local, "mine\n");
  assert.equal(outcome.conflict.remote, "theirs\n");
 }
 assert.equal(readFileSync(join(root, "src", "app.ts"), "utf8"), "theirs\n");
 rmSync(root, { recursive: true, force: true });
});

test("delete removes only files we wrote or that still match import content", async () => {
 const root = dir();
 mkdirSync(join(root, "src"), { recursive: true });
 writeFileSync(join(root, "src", "app.ts"), "saved\n");
 const gone = await performWriteback(input(root, { newContent: null, lastWritten: Buffer.from("saved\n") }));
 assert.equal(gone.status, "deleted");
 assert.equal(existsSync(join(root, "src", "app.ts")), false);
 writeFileSync(join(root, "src", "app.ts"), "external-work\n");
 const kept = await performWriteback(input(root, { newContent: null, lastWritten: Buffer.from("saved\n") }));
 assert.equal(kept.status, "conflict");
 assert.equal(existsSync(join(root, "src", "app.ts")), true);
 rmSync(root, { recursive: true, force: true });
});

test("path traversal and symlink escapes are rejected without writing", async () => {
 const root = dir();
 const outside = dir();
 mkdirSync(join(root, "src"), { recursive: true });
 symlinkSync(join(outside), join(root, "link-out"));
 const evil = await performWriteback(input(root, { docPath: "../escape.ts" }));
 assert.equal(evil.status, "error");
 const sneaky = await performWriteback(input(root, { docPath: "link-out/evil.ts" }));
 assert.equal(sneaky.status, "error");
 assert.equal(existsSync(join(outside, "evil.ts")), false);
 assert.equal(existsSync(join(root, "escape.ts")), false);
 rmSync(root, { recursive: true, force: true });
 rmSync(outside, { recursive: true, force: true });
});

test("resolveBoundFilePath rejects excluded snapshot paths", () => {
 const root = dir();
 assert.throws(() => resolveBoundFilePath(root, "../x.ts"));
 rmSync(root, { recursive: true, force: true });
});

test("forceWriteback overwrites regardless of disk state and removes on null", async () => {
 const root = dir();
 mkdirSync(join(root, "src"), { recursive: true });
 writeFileSync(join(root, "src", "app.ts"), "external\n");
 await forceWriteback(root, "src/app.ts", Buffer.from("forced\n"));
 assert.equal(readFileSync(join(root, "src", "app.ts"), "utf8"), "forced\n");
 await forceWriteback(root, "src/app.ts", null);
 assert.equal(existsSync(join(root, "src", "app.ts")), false);
 rmSync(root, { recursive: true, force: true });
});
