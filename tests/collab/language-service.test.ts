import test from "node:test";
import assert from "node:assert/strict";
import { analyzeCode } from "../../lib/collab/language-service";
import type { LanguageRequest } from "../../lib/collab/language-schema";
const a = 'export const answer: number = 42;\nexport const title = "hello";\n';
const b = 'import { answer, title } from "./a";\nexport const result: string = answer;\nconsole.log(title.toUpperCase());\n';
const files = new Map([["a.ts", a], ["b.ts", b]]);
const query = (action: LanguageRequest["action"], extra: Partial<LanguageRequest> = {}) => analyzeCode(files, "7", { action, path: "b.ts", position: b.indexOf("= answer") + 3, ...extra });
test("cross-file diagnostics use the draft's actual imported types", () => {
  const result = query("diagnostics");
  assert.ok(result.diagnostics?.some(d => d.code === 2322 && /number/.test(d.name)));
  assert.ok(!result.diagnostics?.some(d => d.code === 2307));
});
test("definitions, references, symbols and hover resolve across files", () => {
  assert.equal(query("definition").locations?.[0].path, "a.ts");
  assert.equal(query("references").locations?.length, 3);
  assert.match(query("hover").hover!, /number/);
  assert.ok(query("symbols").locations?.some(l => l.name.startsWith("result")));
});
test("semantic member completion uses bundled standard types and unsaved overlay", () => {
  const text = 'import { title } from "./a";\ntitle.';
  const response = query("complete", { text, position: text.length });
  assert.ok(response.completions?.some(c => c.label === "toUpperCase"));
});
test("rename previews every reference while excluding strings/comments", () => {
  const result = query("rename", { newName: "meaning", path:"a.ts", position:a.indexOf("answer") + 2 });
  assert.equal(result.preview?.changes.length, 2);
  assert.match(result.preview!.changes.find(c => c.path === "a.ts")!.after, /const meaning: number/);
  assert.match(result.preview!.changes.find(c => c.path === "b.ts")!.after, /import \{ meaning, title \}/);
  assert.equal(result.preview?.version, "7");
  assert.throws(() => query("rename", { newName: "class" }), /保留字/);
});
test("organize imports previews unused removal without applying", () => {
  const value = new Map([["a.ts", a], ["b.ts", 'import { answer, title } from "./a";\nconsole.log(answer);\n']]);
  const result = analyzeCode(value, "8", { action: "organize", path: "b.ts", position: 0 });
  assert.match(result.preview!.changes[0].after, /import \{ answer \}/);
  assert.match(value.get("b.ts")!, /title/);
});
test("host filesystem and other projects never participate in module resolution", () => {
  const value = new Map([["b.ts", 'import fs from "node:fs";\nimport x from "/etc/passwd";\nconsole.log(x,fs);']]);
  const result = analyzeCode(value, "8", { action: "diagnostics", path: "b.ts", position: 0 });
  assert.equal(result.diagnostics?.filter(d => d.code === 2307).length, 2);
  assert.throws(() => analyzeCode(value, "8", { action: "hover", path: "a.ts", position: 0 }), /不存在/);
});
test("project compiler options and alias mappings are data only", () => {
  const value = new Map([["src/a.ts", a], ["src/b.ts", 'import { answer } from "@/a";\nexport const x = answer;'], ["tsconfig.json", JSON.stringify({ extends: "/tmp/never-read", compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] }, plugins: [{ name: "/tmp/never-execute" }] } })]]);
  const result = analyzeCode(value, "1", { action: "definition", path: "src/b.ts", position: value.get("src/b.ts")!.lastIndexOf("answer") });
  assert.equal(result.locations?.[0].path, "src/a.ts");
  assert.match(result.notices[0], /extends/);
});
test("quick fixes provide a reviewable patch for a misspelled property", () => {
 const text='export const root = Math.squrt(9);\n';
 const result=analyzeCode(new Map([["a.ts",text]]),"9",{action:"fixes",path:"a.ts",position:text.indexOf("squrt")+1});
 assert.ok(result.codeActions?.some(action=>action.preview.changes.some(c=>c.after.includes("Math.sqrt(9)"))));
});
test("ES5 target loads its default standard library rather than missing array types", () => {
 const result=analyzeCode(new Map([["a.ts",'export const joined = [1,2].join(",");'],["tsconfig.json",'{"compilerOptions":{"target":"es5"}}']]),"1",{action:"diagnostics",path:"a.ts",position:0});
 assert.deepEqual(result.diagnostics,[]);
});
