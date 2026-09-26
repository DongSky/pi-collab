import path from "node:path";
import { homedir } from "node:os";
import { checkDockerDirectory } from "./docker-check";
try {
  await checkDockerDirectory(path.resolve(process.env.PI_COLLAB_DATA_DIR ?? path.join(homedir(), ".pi-collab-docker")));
  console.log("Docker image and data-directory read/write mount verified. This does not certify a deployment or backup.");
} catch (error) { console.error(error instanceof Error ? error.message : "Docker directory check failed"); process.exitCode = 1; }
