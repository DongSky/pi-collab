import { readFile } from "node:fs/promises";
import { applyLocalPromotion } from "../../../lib/collab/runtime/local-promotion";

await applyLocalPromotion(process.argv[2], JSON.parse(await readFile(process.argv[3], "utf8")), new AbortController().signal, {
  afterTargetUpdate: async () => { process.kill(process.pid, "SIGKILL"); await new Promise(() => {}); },
});
