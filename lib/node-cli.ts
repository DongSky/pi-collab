import { existsSync, realpathSync } from "fs";
import { dirname, join, delimiter } from "path";
import { execPath, env } from "process";

export type NodeCliName = "npm" | "npx";

export interface NodeCliLookupOptions {
  /** Directory holding the running `node` binary. Defaults to the real one. */
  nodeDir?: string;
  /** Probe used to test a candidate path, injectable for tests. */
  fileExists?: (path: string) => boolean;
  /** PATH override for tests. Defaults to `process.env.PATH`. */
  pathEnv?: string;
  /** Symlink resolver for the PATH fallback, injectable for tests. */
  realpath?: (path: string) => string;
}

/**
 * Locate the `<name>-cli.js` shipped with the running Node.js installation.
 *
 * On Windows the `npm`/`npx` on PATH are actually `npm.cmd`/`npx.cmd`, which
 * Node.js (since 20.12, due to CVE-2024-27980) refuses to spawn from
 * `execFile`/`spawn` without `shell: true` — the failure mode is a bare
 * `spawn npm ENOENT` on every call. Going through a shell reintroduces quoting
 * bugs for user-supplied args. Instead we find the real CLI script and invoke
 * it directly through the current `node` binary, which works identically on
 * every platform and needs no shell.
 */
export function findNodeCliScript(
  name: NodeCliName,
  options: NodeCliLookupOptions = {},
): string | null {
  const nodeDir = options.nodeDir ?? dirname(execPath);
  const fileExists = options.fileExists ?? existsSync;
  const candidates = [
    // Windows MSI installer layout: node.exe and node_modules share a dir
    join(nodeDir, "node_modules", "npm", "bin", `${name}-cli.js`),
    // Unix layout: .../bin/node + .../lib/node_modules/npm/bin/<name>-cli.js
    join(nodeDir, "..", "lib", "node_modules", "npm", "bin", `${name}-cli.js`),
  ];
  for (const candidate of candidates) {
    try {
      if (fileExists(candidate)) return candidate;
    } catch {
      // ignore
    }
  }
  // Fallback: resolve the binary from PATH (e.g. non-standard installs where
  // node and npm live in different prefixes). If it is a symlink to the real
  // `<name>-cli.js`, use the resolved script so we can still spawn it through
  // the current node binary without a shell.
  try {
    const pathEnv = options.pathEnv ?? env.PATH ?? "";
    const realpath = options.realpath ?? realpathSync;
    for (const dir of pathEnv.split(delimiter)) {
      if (!dir) continue;
      const bin = join(dir, name);
      let real: string;
      try {
        if (!fileExists(bin)) continue;
        real = realpath(bin);
      } catch {
        continue;
      }
      if (real.endsWith(`${name}-cli.js`) && fileExists(real)) return real;
    }
  } catch {
    // ignore
  }
  return null;
}

export interface NodeCliInvocation {
  command: string;
  args: string[];
}

/**
 * `execFile`-spawnable invocation of a Node.js CLI, never routed through a
 * shell. Falls back to the bare command name when no bundled CLI script is
 * found, so behavior is unchanged on installs that ship none.
 */
export function nodeCliInvocation(
  name: NodeCliName,
  args: string[],
  options: NodeCliLookupOptions = {},
): NodeCliInvocation {
  const script = findNodeCliScript(name, options);
  return script
    ? { command: execPath, args: [script, ...args] }
    : { command: name, args };
}
