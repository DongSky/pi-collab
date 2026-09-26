import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// One supervisor owns the cluster for the entire test run. Individual test
// processes still get separate databases, but cannot stop each other's server.
const root = await mkdtemp(path.join(tmpdir(), "pi-collab-tests-"));
const probe = createServer();
let database: { stop(): Promise<unknown> } | undefined;
try {
  await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as { port: number }).port;
  process.env.PI_COLLAB_DATA_DIR = root;
  process.env.PI_COLLAB_DATABASE_PORT = String(port);
  // Import only after selecting the disposable data directory.
  const { localConfig } = await import("./local-config");
  const { startNativeDatabase } = await import("./native-database");
  const config = await localConfig();
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  database = await startNativeDatabase(config);
  const require = createRequire(import.meta.url);
  const postgresRequire = createRequire(require.resolve("embedded-postgres"));
  const exitHook = postgresRequire("async-exit-hook") as { unhookEvent(event: string): void };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) exitHook.unhookEvent(signal);
  const files = process.argv.slice(2);
  if (!files.length) files.push(...(await readdir("tests/collab")).filter(name => name.endsWith(".test.ts")).sort().map(name => `tests/collab/${name}`));
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ["--import", require.resolve("tsx"), "--test", "--test-reporter=tap", "--test-concurrency=2", "--test-timeout=300000", ...files], {
    env, stdio: "inherit", detached: process.platform !== "win32",
  });
  let escalation: ReturnType<typeof setTimeout> | undefined;
  const kill = (signal: NodeJS.Signals) => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    try {
      if (process.platform === "win32") child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  };
  const stop = () => {
    kill("SIGTERM");
    escalation ??= setTimeout(() => kill("SIGKILL"), 10_000);
    escalation.unref();
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, stop);
  try {
    process.exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", code => resolve(code ?? 1));
    });
  } finally {
    if (escalation) clearTimeout(escalation);
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.off(signal, stop);
  }
} finally {
  if (probe.listening) await new Promise<void>(resolve => probe.close(() => resolve()));
  await database?.stop();
  await rm(root, { recursive: true, force: true });
}
