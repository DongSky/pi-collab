import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
const exec = promisify(execFile);
export async function gitSource(root: string) {
  const source = path.join(root, "source"); await mkdir(source);
  for (const args of [["init", "-b", "main"], ["config", "user.name", "Import fixture"], ["config", "user.email", "import@test.invalid"]]) await exec("git", args, { cwd: source });
  await writeFile(path.join(source, "code.txt"), "first commit\n"); await exec("git", ["add", "."], { cwd: source }); await exec("git", ["commit", "-m", "First"], { cwd: source });
  await writeFile(path.join(source, "code.txt"), "second commit\n"); await exec("git", ["add", "."], { cwd: source }); await exec("git", ["commit", "-m", "Second"], { cwd: source });
  await exec("git", ["clone", "--bare", "--no-local", source, path.join(root, "source.git")]);
  return (await exec("git", ["rev-parse", "HEAD"], { cwd: source })).stdout.trim();
}
