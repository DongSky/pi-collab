import test from "node:test";
import assert from "node:assert/strict";
import { OutputRedactor, redactOutput } from "../../lib/collab/runtime/output-redaction.mjs";
import { createPublicEventFilter } from "../../lib/collab/runtime/public-events";

const secrets = [
  "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789",
  "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
  "github_pat_abcdefghijklmnopqrstuvwxyz0123456789",
  "AKIA" + "ABCDEFGHIJKLMNOP", // Synthetic redaction fixture; never a real access key.
  "Bearer abcdefghijklmnopqrstuvwxyz0123456789",
  'api_key = "local confidential value"',
  "postgresql://user:local-password@localhost/database",
  "-----BEGIN PRIVATE KEY-----\nconfidential-key-bytes\n-----END PRIVATE KEY-----",
];
test("output never exposes a credential across any two chunk boundaries", () => {
  for (const secret of secrets) {
    const source = `ready\n${secret}\nafter\n`;
    const expected = redactOutput(source);
    assert.match(expected, /\[REDACTED\]/);
    assert.equal(expected, "ready\n[REDACTED]\nafter\n");
    for (let i = 0; i <= source.length; i++) {
      const filter = new OutputRedactor();
      assert.equal(filter.push(source.slice(0, i)) + filter.push(source.slice(i)), expected);
    }
    const filter = new OutputRedactor();
    assert.equal([...source].map(c => filter.push(c)).join(""), expected);
  }
});
test("normal text, Unicode, ANSI shell prompts and line recovery remain usable", () => {
  const filter = new OutputRedactor();
  const text = "你好，运行中\n\x1b[32muser@host:/project$ \x1b[0m";
  assert.equal(filter.push(text) + filter.push("\n"), text + "\n");
  assert.equal(filter.push('password="sensitive value"\rnext$ '), "[REDACTED]\rnext$ ");
  assert.equal(redactOutput("Build completed"), "Build completed");
  assert.equal(redactOutput("task-123 ask-user passwordless"), "task-123 ask-user passwordless");
});
test("oversized tokens and unfinished process output fail closed with bounded memory", () => {
  const filter = new OutputRedactor();
  assert.equal(filter.push("x".repeat(100_000)), "[REDACTED]");
  assert.equal(filter.token.length, 0);
  assert.equal(filter.push("\ns"), "\n");
  assert.equal(filter.finish(), "[REDACTED]");
});
test("RPC filtering isolates runs and filters both deltas and final tool/message payloads", () => {
  const a = createPublicEventFilter(), b = createPublicEventFilter();
  const delta = (value: string) => ({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: value } });
  assert.equal(a(delta("sk"))?.text, "");
  assert.equal(b(delta("ordinary output "))?.text, "ordinary output ");
  assert.equal(a(delta("-proj-private-value\n"))?.text, "[REDACTED]\n");
  const tool = a({ type: "tool_execution_end", result: { content: [{ type: "text", text: "sk-" }, { type: "text", text: "secret-value\n" }] } });
  assert.equal(JSON.stringify(tool).includes("secret-value"), false);
  const end = a({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: 'password="sensitive"' }], errorMessage: "Bearer secret-error-value" } });
  assert.equal(JSON.stringify(end).includes("sensitive"), false);
  assert.equal(JSON.stringify(end).includes("secret-error-value"), false);
  assert.equal(a(delta("Next message "))?.text, "Next message ");
  assert.equal(a({ type: "terminal_output", text: "ghp_" })?.text, "[REDACTED]");
  assert.equal(a({ type: "terminal_output", text: "secret\n$ " })?.text, "\n$ ");
});

test("terminal frame boundaries do not drop a buffered prompt token", () => {
  const filter = createPublicEventFilter();
  assert.equal(filter({ type: "terminal_output", text: "a" })?.text, "");
  const frame = "b ".repeat(8000);
  assert.equal(filter({ type: "terminal_output", text: frame })?.text, "a" + frame);
});
