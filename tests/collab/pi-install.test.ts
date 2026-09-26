import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile, readlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import collab from "../../extensions/pi-collab";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { packageRuntimeRoot, preparePackageRuntime } from "../../scripts/pi-package-root";

const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");
const cli = path.join(root, "bin/pi-collab.cjs");

test("real pi install discovers /collab without starting services or changing user settings", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "pi-collab-install-"));
  try {
    const agentDir = path.join(temp, "agent"), cwd = path.join(temp, "cwd");
    await mkdir(cwd);
    const piCli = fileURLToPath(new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
    await exec(process.execPath, [piCli, "install", root], { cwd, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" } });
    const settings = JSON.parse(await readFile(path.join(agentDir, "settings.json"), "utf8"));
    assert.ok(settings.packages.some((source: string) => path.resolve(agentDir, source) === root));
    const loader = new DefaultResourceLoader({ cwd, agentDir, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    assert.ok(loaded.extensions.some(extension => extension.commands.has("collab")));
    await assert.rejects(readFile(path.join(temp, "config.json")), /ENOENT/);
    await exec(process.execPath, [piCli, "remove", root], { cwd, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" } });
    assert.ok(!JSON.parse(await readFile(path.join(agentDir, "settings.json"), "utf8")).packages.includes(root));
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("slash command forwards port arguments without a shell and rejects arbitrary commands", async () => {
  let handler!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  const calls: string[][] = [], notices: string[] = [];
  collab({ registerCommand: (_name: string, options: Parameters<ExtensionAPI["registerCommand"]>[1]) => { handler = options.handler; }, exec: async (_file: string, args: string[]) => {
    calls.push(args); return { code: 0, stdout: "ready", stderr: "", killed: false };
  } } as unknown as ExtensionAPI);
  const ctx = { ui: { notify: (text: string) => notices.push(text) } } as unknown as ExtensionCommandContext;
  await handler("start --port 30200 --gateway-port 30201 --database-port 55440", ctx);
  assert.deepEqual(calls[0].slice(1), ["start", "--port", "30200", "--gateway-port", "30201", "--database-port", "55440"]);
  await handler("start; touch /tmp/unsafe", ctx);
  await handler("stop --port 30200", ctx);
  assert.equal(calls.length, 1);
  assert.ok(notices.some(text => text.includes("用法")));
});

test("launcher rejects invalid and colliding ports before creating credentials or starting processes", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "pi-collab-ports-"));
  try {
    for (const args of [["--port", "0"], ["--port", "65536"], ["--port", "30200", "--gateway-port", "30200"]]) {
      await assert.rejects(exec(process.execPath, [cli, "start", "--data-dir", temp, ...args]), /must be|must be different/);
      await assert.rejects(readFile(path.join(temp, "config.json")), /ENOENT/);
    }
    const status = await exec(process.execPath, [cli, "status", "--data-dir", temp]);
    assert.match(status.stdout, /尚未启动/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("npm source package contains launcher, migrations and runtime source but no local data or build cache", async () => {
  const result = await exec("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, maxBuffer: 8 * 1024 * 1024 });
  const files = new Set(JSON.parse(result.stdout)[0].files.map((file: { path: string }) => file.path));
  for (const name of ["bin/pi-collab.cjs", "extensions/pi-collab.ts", "scripts/dev-local.ts", "scripts/pi-launcher.ts", "scripts/package.json", "lib/collab/runtime/service-runner.mjs", "app/page.tsx", "tsconfig.json", "postcss.config.mjs"]) assert.ok(files.has(name), name);
  assert.ok([...files].some(name => String(name).startsWith("db/migrations/")));
  assert.equal([...files].some(name => /(^|\/)\.local\/|(^|\/)\.env|^\.next\//.test(String(name))), false);
});

test("npm runtime staging keeps source outside node_modules and refuses to rewrite a running copy", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "pi-collab-staging-"));
  try {
    const source = path.join(temp, "node_modules/pi-collab"), dependencies = path.join(temp, "node_modules");
    for (const dir of ["app", "components", "hooks", "lib", "scripts", "db", "public", "bin", "extensions", ".local"]) await mkdir(path.join(source, dir), { recursive: true });
    for (const file of ["next.config.ts", "tsconfig.json", "postcss.config.mjs", "proxy.ts", "package.json"]) await writeFile(path.join(source, file), "{}");
    await writeFile(path.join(source, ".local/secret"), "do not copy");
    const destination = packageRuntimeRoot(source);
    assert.ok(destination.startsWith(path.join(temp, ".pi-collab-runtime")));
    assert.equal(packageRuntimeRoot(temp), temp);
    await preparePackageRuntime(source, destination, dependencies);
    assert.equal(await readlink(path.join(destination, "node_modules")), dependencies);
    await assert.rejects(readFile(path.join(destination, ".local/secret")), /ENOENT/);
    await mkdir(path.join(destination, ".next/dev"), { recursive: true });
    await writeFile(path.join(destination, ".next/dev/lock"), "");
    await writeFile(path.join(destination, "app/preserved"), "live");
    await assert.rejects(preparePackageRuntime(source, destination, dependencies), /已有 Next/);
    assert.equal(await readFile(path.join(destination, "app/preserved"), "utf8"), "live");
  } finally { await rm(temp, { recursive: true, force: true }); }
});
