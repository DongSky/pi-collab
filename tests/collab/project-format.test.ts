import test from "node:test";
import assert from "node:assert/strict";
import { projectFormatOptions } from "../../lib/collab/project-format";
import { formatCode } from "../../lib/collab/format-code";
test("nearest JSON/YAML formatter config and overrides affect actual output", async () => {
 const files = new Map([[".prettierrc",'semi: false\nsingleQuote: true\ntabWidth: 4\noverrides:\n  - files: "*.ts"\n    options:\n      semi: true\n'],["src/.prettierrc.json",'{"semi":false,"singleQuote":true}']]);
 const nearest=projectFormatOptions(files,"src/file.ts");assert.equal(nearest.config,"src/.prettierrc.json");
 assert.equal(await formatCode("src/file.ts",'const text="hello";',nearest.options),"const text = 'hello'\n");
 assert.equal(projectFormatOptions(files,"lib/file.ts").options.semi,true);
});
test("package config is supported; malformed or executable config is never run", () => {
 assert.equal(projectFormatOptions(new Map([["package.json",'{"prettier":{"tabWidth":4}}']]),"src/a.ts").options.tabWidth,4);
 assert.throws(()=>projectFormatOptions(new Map([[".prettierrc","semi: maybe"]]),"a.ts"),/无效/);
 assert.throws(()=>projectFormatOptions(new Map([["prettier.config.js","throw new Error('must not execute')"]]),"a.ts"),/可执行/);
 assert.throws(()=>projectFormatOptions(new Map([[".prettierrc",'{"plugins":["evil"]}']]),"a.ts"),/插件/);
 assert.equal(projectFormatOptions(new Map(),"a.ts").config,"Prettier 默认配置");
});
