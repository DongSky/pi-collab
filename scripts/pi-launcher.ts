import { spawn, execFile } from "node:child_process";
import { promisify, parseArgs } from "node:util";
import { mkdir, readFile, open, access, writeFile, rename, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import lockfile from "proper-lockfile";
import { nativeBootId } from "../lib/collab/runtime/receipts";
import { packageRuntimeRoot, preparePackageRuntime } from "./pi-package-root";

const exec = promisify(execFile);
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const runtimeRoot = packageRuntimeRoot(path.resolve(root));
const help = `pi-collab start|status|open|stop|resume [--data-dir PATH]
start 可指定 --port N --database-port N --gateway-port N；更换端口前须 stop。
默认无 Docker；后台运行，退出 Pi 不会停止服务。stop 会先排空，有未结束任务时拒绝停止。
默认数据：~/.pi/collab（可用 PI_COLLAB_DATA_DIR 覆盖）。更新/卸载插件不会删除该目录。
本入口为本机开发模式；团队生产部署请使用 release 安装包。`;

async function main() {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    "data-dir": { type: "string" }, port: { type: "string" },
    "database-port": { type: "string" }, "gateway-port": { type: "string" }, help: { type: "boolean" },
  } });
  const command = positionals[0] ?? "help";
  if (values.help || command === "help") { console.log(help); return; }
  if (positionals.length !== 1 || !["start", "status", "open", "stop", "resume"].includes(command)) throw new Error(help);
  if (process.env.PI_COLLAB_DEPLOYMENT === "production") throw new Error("生产部署请使用 release 安装包和 ops 命令。");
  process.env.PI_COLLAB_DATA_DIR = path.resolve(values["data-dir"] ?? process.env.PI_COLLAB_DATA_DIR ?? path.join(homedir(), ".pi/collab"));
  const relativeData = path.relative(runtimeRoot, process.env.PI_COLLAB_DATA_DIR);
  if (runtimeRoot !== path.resolve(root) && (relativeData === "" || (!relativeData.startsWith(`..${path.sep}`) && relativeData !== ".." && !path.isAbsolute(relativeData)))) {
    throw new Error("数据目录不能位于可重新生成的 npm 运行副本内，请使用独立目录。");
  }
  process.env.PI_COLLAB_DEPLOYMENT = "local";
  process.env.PI_COLLAB_RUNTIME = "native";
  process.chdir(root);
  const { dataRoot, localConfig } = await import("./local-config");
  for (const [option, variable] of [["port", "PI_COLLAB_PORT"], ["database-port", "PI_COLLAB_DATABASE_PORT"], ["gateway-port", "PI_COLLAB_GATEWAY_PORT"]] as const) {
    if (values[option] !== undefined) {
      if (command !== "start") throw new Error("端口选项仅用于 start。");
      if (!/^\d+$/.test(values[option]) || Number(values[option]) < 1024 || Number(values[option]) > 65535) throw new Error(`${option} must be an integer from 1024 to 65535`);
      process.env[variable] = values[option];
    }
  }
  if (command !== "start") {
    try { await access(path.join(dataRoot, "config.json")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; console.log(`尚未启动。数据目录：${dataRoot}`); return; }
  }
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  const marker = await open(path.join(dataRoot, "launcher"), "a", 0o600); await marker.close();
  const release = await lockfile.lock(path.join(dataRoot, "launcher"), { retries: 0 });
  try {
    const config = await localConfig();
    const logfile = path.join(dataRoot, "launcher.log");
    async function running() {
      let record;
      try { record = JSON.parse(await readFile(path.join(dataRoot, "supervisor.json"), "utf8")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
      if (record.bootId !== await nativeBootId()) return false;
      if (!Number.isInteger(record.pid) || record.pid < 2) throw new Error("Invalid supervisor identity");
      try { process.kill(record.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
      if (record.cwd !== await realpath(runtimeRoot)) throw new Error("该数据目录由另一安装目录运行；请先通过原安装停止服务。");
      let name: string;
      try { name = (await exec("ps", ["-p", String(record.pid), "-o", "stat=", "-o", "command="])).stdout; }
      catch (error) {
        // The supervisor can exit between kill(0) and ps during graceful stop.
        if ((error as { code?: unknown }).code === 1) return false;
        throw error;
      }
      if (/^\s*Z/.test(name)) return false;
      if (!name.includes("scripts/dev-local.ts")) throw new Error("Supervisor identity mismatch; no process was stopped");
      return true;
    }
    const nextConfig = { ...config };
    for (const [option, field] of [["port", "port"], ["database-port", "databasePort"], ["gateway-port", "gatewayPort"]] as const) {
      if (values[option]) nextConfig[field] = Number(values[option]);
    }
    if (new Set([nextConfig.port, nextConfig.databasePort, nextConfig.gatewayPort]).size !== 3) throw new Error("Web, database and gateway ports must be different");
    if (["port", "databasePort", "gatewayPort"].some(key => config[key as keyof typeof config] !== nextConfig[key as keyof typeof config])) {
      if (await running()) throw new Error("更换端口前请先 /collab stop；运行中的配置未修改。");
      const { operationLock, assertCold } = await import("./operations-core");
      const unlock = await operationLock(dataRoot);
      try {
        await assertCold(dataRoot);
        const temporary = path.join(dataRoot, `config.${process.pid}.tmp`);
        await writeFile(temporary, JSON.stringify(nextConfig, null, 2) + "\n", { mode: 0o600, flag: "wx" });
        await rename(temporary, path.join(dataRoot, "config.json"));
        Object.assign(config, nextConfig);
      } finally { await unlock(); }
    }
    const url = `http://127.0.0.1:${config.port}`;
    const operation = async (name: string, reason?: string) => {
      const result = await exec(process.execPath, ["--import", require.resolve("tsx"), "scripts/operations.ts", name, ...(reason ? ["--reason", reason] : [])], { cwd: runtimeRoot, env: process.env, timeout: 30_000 });
      return result.stdout.trim();
    };
    if (command === "start") {
      if (!await running()) {
        await mkdir(path.dirname(runtimeRoot), { recursive: true, mode: 0o700 });
        const unlockInstallation = await lockfile.lock(`${runtimeRoot}.launch`, { realpath: false, retries: 0 });
        try {
          // Dependency checks are read-only; local pi install deliberately does not run npm install.
          for (const name of ["tsx", "embedded-postgres", "next", "@tailwindcss/postcss"]) require.resolve(name);
          await exec("git", ["--version"]); await exec("python3", ["--version"]);
          const dependencies = path.dirname(path.dirname(require.resolve("next/package.json")));
          await preparePackageRuntime(path.resolve(root), runtimeRoot, dependencies);
          const log = await open(logfile, "a", 0o600);
          const child = spawn(process.execPath, ["--import", require.resolve("tsx"), "scripts/dev-local.ts"], { cwd: runtimeRoot, env: process.env, detached: true, stdio: ["ignore", log.fd, log.fd] });
          await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); }).finally(() => log.close());
          child.unref();
          const deadline = Date.now() + 120_000;
          let ready = false;
          while (Date.now() < deadline) {
            if (child.exitCode !== null || child.signalCode !== null) throw new Error(`启动失败，请检查 ${logfile}；已有实例和数据未被停止或覆盖。`);
            if (await running()) {
              try {
                const response = await fetch(`${url}/api/collab/setup`, { signal: AbortSignal.timeout(2500) });
                const body = await response.json();
                if (response.ok && typeof body.needed === "boolean") { ready = true; break; }
              } catch { /* Database migration and initial compilation can take time. */ }
            }
            await new Promise(resolve => setTimeout(resolve, 500));
          }
          if (!ready) throw new Error(`启动尚未就绪，后台进程保留。使用 status 核查，日志：${logfile}`);
        } finally { await unlockInstallation(); }
      }
      console.log(`pi-collab：${url}\n数据：${dataRoot}\n初始化令牌在 ${path.join(dataRoot, "config.json")} 的 bootstrapToken 字段。\n日志：${logfile}`);
    } else if (!await running()) {
      console.log(`未运行。数据保留在 ${dataRoot}`);
    } else if (command === "status") {
      console.log(`${url}\n${await operation("status")}\n日志：${logfile}`);
    } else if (command === "stop") {
      await operation("drain", "User requested stop through pi-collab launcher");
      try { await operation("stop"); }
      catch { throw new Error("已进入排空状态，停止未完成。请用 status 查看未结束任务；处理后再次 stop，或 resume 取消排空。"); }
      const deadline = Date.now() + 30_000;
      // Shutdown may change the process title before it exits. The supervisor
      // removes its receipt only after workers and its database have stopped.
      while (true) {
        try { await access(path.join(dataRoot, "supervisor.json")); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") break; throw error; }
        if (Date.now() > deadline) throw new Error("正在停止，请稍后用 status 核查；未强杀进程。");
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      console.log("已停止，数据已保留。再次 start 后用 resume 恢复接收任务。");
    } else if (command === "resume") {
      console.log(await operation("resume", "User requested resume through pi-collab launcher"));
    } else if (command === "open") {
      const opener = process.platform === "darwin" ? "open" : "xdg-open";
      await exec(opener, [url]); console.log(url);
    }
  } finally { await release(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : "pi-collab failed"); process.exitCode = 1; });
