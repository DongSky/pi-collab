import EmbeddedPostgres from "embedded-postgres";
import { Client } from "pg";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { connectionString, dataRoot, type LocalConfig } from "./local-config";

export async function startNativeDatabase(config: LocalConfig) {
  // A successful authenticated connection proves reuse; a PID file alone does not.
  const probe = new Client({ connectionString: connectionString(config, true, "postgres"), connectionTimeoutMillis: 1500 });
  try {
    await probe.connect();
    const { rows } = await probe.query("show data_directory");
    if (path.resolve(rows[0].data_directory) !== path.join(dataRoot, "postgres")) {
      throw new Error("Configured database port belongs to a different data directory");
    }
    return { owned: false, stop: async () => {} };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ECONNREFUSED") throw error;
  } finally { await probe.end(); }

  // All application and administration clients use authenticated loopback TCP.
  // Disable unused Unix sockets: a valid long data directory otherwise exceeds
  // macOS/Linux sockaddr_un limits and prevents PostgreSQL from starting.
  await mkdir(path.join(dataRoot, "postgres"), { recursive: true, mode: 0o700 });
  const database = new EmbeddedPostgres({
    databaseDir: path.join(dataRoot, "postgres"), user: "pi_collab_admin",
    password: config.adminPassword, port: config.databasePort, persistent: true,
    authMethod: "scram-sha-256", createPostgresUser: false,
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    postgresFlags: ["-h", "127.0.0.1", "-c", "unix_socket_directories=", "-c", "max_connections=60"],
    onLog: () => {},
    onError: (message) => {
      if (/FATAL|PANIC/i.test(String(message))) console.error(String(message));
    },
  });
  try { await access(path.join(dataRoot, "postgres", "PG_VERSION")); }
  catch { await database.initialise(); }
  await database.start();
  return { owned: true, stop: () => database.stop() };
}
