import { DEFAULT_RUNNER_IMAGE } from "../lib/collab/runtime/container-image";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
const exec = promisify(execFile);

/** Exercise real daemon read/write mounts using only a fresh disposable marker. */
export async function checkDockerDirectory(root: string) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const probe = await mkdtemp(path.join(root, ".docker-probe-")), name = `pi-collab-probe-${randomUUID()}`, marker = randomUUID();
  let failure: Error | undefined;
  try {
    await writeFile(path.join(probe, "input"), marker, { mode: 0o600 });
    const image = (await exec("docker", ["image", "inspect", DEFAULT_RUNNER_IMAGE, "--format", "{{.Id}}"], { timeout: 10000 })).stdout.trim();
    await exec("docker", ["run", "--name", name, "--pull=never", "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--user", `${process.getuid!()}:${process.getgid!()}`, "--entrypoint", "node", "--mount", `type=bind,source=${probe},target=/probe`, image, "-e", "require('node:fs').writeFileSync('/probe/output',require('node:fs').readFileSync('/probe/input'))"], { timeout: 15000 });
    if (await readFile(path.join(probe, "output"), "utf8") !== marker) throw new Error("Mount byte verification failed");
  } catch {
    failure = new Error("Docker image or persistent read/write mount is unavailable. Build runner:docker:build and choose a persistent PI_COLLAB_DATA_DIR shared with Docker Desktop. No Docker settings were changed; native mode is unaffected.");
  } finally {
    await exec("docker", ["rm", "-f", name], { timeout: 10000 }).catch(() => {});
    await rm(probe, { recursive: true, force: true });
  }
  if (failure) throw failure;
}
