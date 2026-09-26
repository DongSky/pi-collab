import {createServer as createHttpServer} from "node:http";
import { resolveCollabSuite } from "../e2e/collab-suites.mjs";
import {previewHandler,sweepPreviews} from "../lib/collab/preview-server";
import {gatewayConnectionString} from "./local-config";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile, open } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Pool } from "pg";
import { applicationEnvironment, connectionString, dataRoot, localConfig } from "./local-config";
import { startNativeDatabase } from "./native-database";
import { migrate } from "./migrate";
import { startMailFixture } from "./e2e-mail";

// This runs Next from a private source copy: no shared .next, generated types,
// development accounts, auth cookies or schema state with the active checkout.
process.env.PI_COLLAB_E2E_FOCUS = resolveCollabSuite(process.env.PI_COLLAB_E2E_FOCUS);
const root = process.cwd(), config = await localConfig();
const manual = process.argv.includes("--manual");
const productionServer = !manual && process.env.E2E_SERVER_MODE === "start";
// The manual browser sandbox contains no real accounts or provider secrets.
// Its public fixture token must never replace the primary instance's token.
const fixtureConfig = manual ? { ...config, authSecret: randomBytes(32).toString("hex"), bootstrapToken: "c".repeat(64) } : config;
const databaseName = `pi_collab_test_${randomBytes(6).toString("hex")}`;
const native = await startNativeDatabase(config);
const directory = await mkdtemp(path.join(dataRoot, "identity-e2e-"));
const runtimeDirectory = process.env.PI_COLLAB_RUNTIME === "docker" ? await mkdtemp(path.join(tmpdir(), "identity-e2e-")) : directory;
await mkdir("test-results/collab", { recursive: true });
const log = await open("test-results/collab/identity-server.log", "w", 0o600);
let server: ReturnType<typeof spawn> | undefined;
let mail: Awaited<ReturnType<typeof startMailFixture>> | undefined;
let previews:ReturnType<typeof createHttpServer>|undefined,previewDb:Pool|undefined;
try {
  Object.assign(process.env, applicationEnvironment(config));
  await migrate(fixtureConfig, databaseName);
  for (const entry of ["app", "components", "hooks", "lib", "public", "package.json", "tsconfig.json", "postcss.config.mjs", "proxy.ts"]) {
    await cp(path.join(root, entry), path.join(directory, entry), { recursive: true });
  }
  await symlink(path.join(root, "node_modules"), path.join(directory, "node_modules"));
  const nextConfig = await readFile("next.config.ts", "utf8");
  await writeFile(path.join(directory, "next.config.ts"), nextConfig);
  const probe = createServer();
  await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  const url = `http://127.0.0.1:${port}`;
  let previewOrigin=applicationEnvironment(config).PI_COLLAB_PREVIEW_ORIGIN;
  if(process.env.PI_COLLAB_E2E_FOCUS==='previews'){
    previewDb=new Pool({connectionString:gatewayConnectionString(config,databaseName)});
    const handle=previewHandler(previewDb,runtimeDirectory,url);
    previews=createHttpServer((req,res)=>{void handle(req,res).then(handled=>{if(!handled){res.writeHead(404);res.end();}});});
    await new Promise<void>(resolve=>previews!.listen(0,'127.0.0.1',resolve));
    previewOrigin=`http://127.0.0.1:${(previews.address() as {port:number}).port}`;
  }
  if (productionServer) mail = await startMailFixture(runtimeDirectory);
  const env: NodeJS.ProcessEnv = { ...applicationEnvironment(fixtureConfig), ...(productionServer ? { NODE_ENV: "production", ...mail!.env } : {}), ...(manual ? { PI_COLLAB_AUTH_COOKIE_PREFIX: databaseName } : {}), PI_COLLAB_PREVIEW_ORIGIN:previewOrigin, DATABASE_URL: connectionString(config, false, databaseName), BETTER_AUTH_URL: url, PI_COLLAB_DATA_DIR: runtimeDirectory };
  if (productionServer) {
    // Build only the disposable copy, never the active developer checkout.
    console.log("Building the isolated production browser fixture...");
    const build = spawn(process.execPath, [path.join(root, "node_modules/next/dist/bin/next"), "build", "--webpack"], { cwd: directory, env, stdio: ["ignore", log.fd, log.fd] });
    const code = await new Promise<number>((resolve, reject) => { build.once("error", reject); build.once("exit", value => resolve(value ?? 1)); });
    if (code) throw new Error("Isolated production build failed; inspect private identity-server.log");
    console.log("Isolated production build passed; starting browser acceptance.");
  }
  server = spawn(process.execPath, [path.join(root, "node_modules/next/dist/bin/next"), productionServer ? "start" : "dev", "-H", "127.0.0.1", "-p", String(port)], { cwd: directory, env, stdio: ["ignore", log.fd, log.fd], detached: true });
  const readyBy = Date.now() + 60_000;
  for (;;) {
    if (server.exitCode !== null) throw new Error("Isolated web server exited; inspect private identity-server.log");
    try { if ((await fetch(`${url}/sign-in`)).ok) break; } catch {}
    if (Date.now() > readyBy) throw new Error("Isolated web server did not start; inspect private identity-server.log");
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  if (manual) {
    console.log(JSON.stringify({ manual: true, url, directory, runtimeDirectory, databaseName, setupToken: "c".repeat(64) }));
    console.log("Disposable manual acceptance is ready. Stop with SIGINT or SIGTERM to remove only this fixture.");
    await new Promise<void>(resolve => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
      server!.once("exit", resolve);
    });
  } else {
  const test = spawn(process.execPath, ["e2e/collab-identity.mjs"], {
    cwd: root, env: { ...process.env, PI_COLLAB_E2E_URL: url, PI_COLLAB_E2E_DATA: runtimeDirectory, PI_COLLAB_E2E_DATABASE: databaseName }, stdio: "inherit",
  });
  const code = await new Promise<number>(resolve => test.once("exit", value => resolve(value ?? 1)));
  if (code) throw new Error("Identity browser acceptance failed");
  }
} finally {
  if (server?.pid && server.exitCode === null) {
    process.kill(-server.pid, "SIGTERM");
    await Promise.race([new Promise(resolve => server!.once("exit", resolve)), new Promise(resolve => setTimeout(resolve, 5000))]);
    // Reap any Next child still in the dedicated process group before cleanup.
    try { process.kill(-server.pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  }
  if(previews){previews.closeAllConnections();await new Promise<void>(resolve=>previews!.close(()=>resolve()));await sweepPreviews(previewDb!,runtimeDirectory);await previewDb!.end();}
  await mail?.close();
  await log.close();
  const cleanup = new Pool({ connectionString: connectionString(config, true, "postgres") });
  const resourceAdmin = new Pool({ connectionString: connectionString(config, true, databaseName) });
  let resourceRoles: string[] = [];
  try { if ((await resourceAdmin.query("SELECT to_regclass('collab_broker.credentials') AS table")).rows[0].table) resourceRoles = (await resourceAdmin.query("SELECT role_name FROM collab_broker.credentials")).rows.map(row => row.role_name); }
  finally { await resourceAdmin.end(); }
  await cleanup.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  for (const role of resourceRoles) { if (!/^pcr_[a-f0-9]{32}$/.test(role)) throw new Error("Unexpected disposable resource role"); await cleanup.query(`DROP ROLE "${role}"`); }
  await cleanup.end();
  await rm(directory, { recursive: true, force: true }); if(runtimeDirectory!==directory)await rm(runtimeDirectory,{recursive:true,force:true}); await native.stop();
}
