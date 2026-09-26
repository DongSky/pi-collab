import path from "node:path";
import { homedir } from "node:os";
import { checkDockerDirectory } from "./docker-check";
// Separate persistent profile. Probe disposable bytes, never control-plane secrets.
process.env.PI_COLLAB_RUNTIME = "docker";
process.env.PI_COLLAB_DATA_DIR ??= path.join(homedir(), ".pi-collab-docker");
await checkDockerDirectory(path.resolve(process.env.PI_COLLAB_DATA_DIR));
await import("./dev-local");
