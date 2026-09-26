import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";

/** Loading the package only registers a command; it never starts services. */
export default function collab(pi: ExtensionAPI) {
  const launcher = fileURLToPath(new URL("../bin/pi-collab.cjs", import.meta.url));
  pi.registerCommand("collab", {
    description: "pi-collab：start / status / open / stop / resume（默认无 Docker）",
    getArgumentCompletions: prefix => ["start", "status", "open", "stop", "resume", "help"]
      .filter(value => value.startsWith(prefix)).map(value => ({ value, label: value })),
    handler: async (args, ctx) => {
      const argv = (args.trim() || "help").split(/\s+/);
      const command = argv[0];
      if (!["start", "status", "open", "stop", "resume", "help"].includes(command)
        || (argv.length > 1 && (command !== "start" || !/^(?: --(?:port|database-port|gateway-port) \d+)+$/.test(" " + argv.slice(1).join(" "))))) {
        ctx.ui.notify("用法：/collab start [--port 30200] [--database-port 55440] [--gateway-port 30201]，或 /collab status|open|stop|resume。", "warning");
        return;
      }
      ctx.ui.notify(`pi-collab ${command}…`, "info");
      try {
        const result = await pi.exec(process.execPath, [launcher, ...argv], { timeout: 180_000 });
        ctx.ui.notify((result.stdout + "\n" + result.stderr).trim() || "操作结束", result.code === 0 ? "info" : "error");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : "pi-collab 操作失败", "error");
      }
    },
  });
}
