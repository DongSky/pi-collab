import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  AUTO_VERIFY_MAX_ROUNDS,
  buildAutoVerifyPrompt,
  lastTurnWroteFiles,
  loadAutoVerifySettings,
  saveAutoVerifySettings,
} = await jiti.import("./auto-verify.ts");

// ---- localStorage stub ----
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

test("max rounds is a small sane cap", () => {
  assert.equal(AUTO_VERIFY_MAX_ROUNDS, 2);
});

test("buildAutoVerifyPrompt: first round asks to install deps, verify, fix", () => {
  const p = buildAutoVerifyPrompt(0, null);
  assert.match(p, /\[自动验证\]/);
  assert.match(p, /npm ci/);
  assert.match(p, /npm test/);
  assert.match(p, /修复/);
});

test("buildAutoVerifyPrompt: explicit commands are listed", () => {
  const p = buildAutoVerifyPrompt(0, ["make check", "make build"]);
  assert.match(p, /make check/);
  assert.match(p, /make build/);
  assert.doesNotMatch(p, /package\.json/);
});

test("buildAutoVerifyPrompt: retry round says it is the last one", () => {
  const p = buildAutoVerifyPrompt(1, null);
  assert.match(p, /第 2 轮/);
  assert.match(p, /最后一轮/);
});

test("settings round-trip per cwd", () => {
  store.clear();
  assert.deepEqual(loadAutoVerifySettings("/a"), { enabled: true, commands: null });
  saveAutoVerifySettings("/a", { enabled: false, commands: ["make test"] });
  assert.deepEqual(loadAutoVerifySettings("/a"), { enabled: false, commands: ["make test"] });
  // other cwd unaffected
  assert.deepEqual(loadAutoVerifySettings("/b"), { enabled: true, commands: null });
  // empty commands list normalizes to null (auto-detect)
  saveAutoVerifySettings("/a", { enabled: true, commands: [] });
  assert.deepEqual(loadAutoVerifySettings("/a"), { enabled: true, commands: null });
});

test("settings survive malformed storage", () => {
  store.clear();
  store.set("pi-web:auto-verify", "not-json{{{");
  assert.deepEqual(loadAutoVerifySettings("/a"), { enabled: true, commands: null });
  store.set("pi-web:auto-verify", JSON.stringify({ "/a": { enabled: "yes", commands: [1, " x "] } }));
  assert.deepEqual(loadAutoVerifySettings("/a"), { enabled: true, commands: ["x"] });
});

function toolCall(toolCallId, toolName, input) {
  return { type: "toolCall", toolCallId, toolName, input };
}
function okResult(toolCallId) {
  return { role: "toolResult", toolCallId, content: [{ type: "text", text: "ok" }] };
}
function results(...entries) {
  const m = new Map();
  for (const e of entries) m.set(e.toolCallId, e);
  return m;
}
const userMsg = { role: "user", content: "do it" };
const assistantMsg = (content) => ({ role: "assistant", content });

test("lastTurnWroteFiles: detects successful writes after last user message", () => {
  const messages = [
    userMsg,
    assistantMsg([toolCall("1", "write", { path: "/a.ts", content: "x" })]),
  ];
  const r = results(okResult("1"));
  assert.equal(lastTurnWroteFiles(messages, r, "/"), true);
});

test("lastTurnWroteFiles: ignores failed writes and earlier turns", () => {
  const messages = [
    assistantMsg([toolCall("0", "write", { path: "/old.ts", content: "x" })]),
    userMsg,
    assistantMsg([toolCall("1", "write", { path: "/a.ts", content: "x" })]),
  ];
  const r = results(okResult("0"), { role: "toolResult", toolCallId: "1", isError: true, content: [] });
  assert.equal(lastTurnWroteFiles(messages, r, "/"), false);
});

test("lastTurnWroteFiles: false when nothing written or no user message", () => {
  assert.equal(lastTurnWroteFiles([assistantMsg([{ type: "text", text: "hi" }])], new Map(), "/"), false);
  assert.equal(lastTurnWroteFiles([], new Map(), "/"), false);
  assert.equal(
    lastTurnWroteFiles([userMsg, assistantMsg([{ type: "text", text: "done, all tests pass" }])], new Map(), "/"),
    false,
  );
});
