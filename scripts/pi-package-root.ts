import { createHash } from "node:crypto";
import { access, cp, mkdir, rm, symlink } from "node:fs/promises";
import path from "node:path";

export function packageRuntimeRoot(source: string) {
  let directory = path.resolve(source);
  while (path.dirname(directory) !== directory) {
    if (path.basename(directory) === "node_modules") {
      return path.join(path.dirname(directory), ".pi-collab-runtime", createHash("sha256").update(path.resolve(source)).digest("hex").slice(0, 16));
    }
    directory = path.dirname(directory);
  }
  return source;
}

/** Turbopack treats sources under node_modules as external modules. Stage only
 * shipped application files outside it; persistent user data never lives here. */
export async function preparePackageRuntime(source: string, destination: string, dependencies: string) {
  if (source === destination) return;
  try {
    await access(path.join(destination, ".next/dev/lock"));
    throw new Error("该安装目录已有 Next 开发实例；先停止原实例再启动，不能仅更换端口。");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { mode: 0o700 });
  for (const name of ["app", "components", "hooks", "lib", "scripts", "db", "public", "bin", "extensions", "next.config.ts", "tsconfig.json", "postcss.config.mjs", "proxy.ts", "package.json"]) {
    await cp(path.join(source, name), path.join(destination, name), { recursive: true });
  }
  await symlink(dependencies, path.join(destination, "node_modules"), "dir");
}
