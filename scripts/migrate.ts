import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { Client, Pool } from "pg";
import { getMigrations } from "better-auth/db/migration";
import { authOptions } from "../lib/collab/auth";
import { applicationEnvironment, connectionString, localConfig, type LocalConfig } from "./local-config";

export async function migrate(config: LocalConfig, databaseName = "pi_collab") {
  if (!/^pi_collab(?:_test_[a-f0-9]+)?$/.test(databaseName)) throw new Error("Invalid application database name");
  const setup = new Client({ connectionString: connectionString(config, true, "postgres") });
  await setup.connect();
  try {
    await setup.query("SELECT pg_advisory_lock(82467100)");
    if (!(await setup.query("SELECT 1 FROM pg_database WHERE datname=$1", [databaseName])).rowCount) {
      await setup.query(`CREATE DATABASE "${databaseName}"`);
    }
    if (!(await setup.query("SELECT 1 FROM pg_roles WHERE rolname='pi_collab_app'")).rowCount) {
      // Generated local password is hex, nevertheless quote as a SQL literal.
      const password = config.appPassword.replaceAll("'", "''");
      await setup.query(`CREATE ROLE pi_collab_app LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
    }
    if (!(await setup.query("SELECT 1 FROM pg_roles WHERE rolname='pi_collab_executor'")).rowCount) {
      const password = config.executorPassword.replaceAll("'", "''");
      await setup.query(`CREATE ROLE pi_collab_executor LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
    }
    if (!(await setup.query("SELECT 1 FROM pg_roles WHERE rolname='pi_collab_broker'")).rowCount) {
      const password = config.brokerPassword.replaceAll("'", "''");
      await setup.query(`CREATE ROLE pi_collab_broker LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
    }
    if (!(await setup.query("SELECT 1 FROM pg_roles WHERE rolname='pi_collab_git'")).rowCount) {
      const password = config.gitPassword.replaceAll("'", "''");
      await setup.query(`CREATE ROLE pi_collab_git LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
    }
    if (!(await setup.query("SELECT 1 FROM pg_roles WHERE rolname='pi_collab_gateway'")).rowCount) {
      const password = config.gatewayPassword.replaceAll("'", "''");
      await setup.query(`CREATE ROLE pi_collab_gateway LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
    }
  } finally { await setup.query("SELECT pg_advisory_unlock(82467100)"); await setup.end(); }

  const pool = new Pool({ connectionString: connectionString(config, true, databaseName), max: 2 });
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(82467101)");
    await client.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
    // Pinned Better Auth schema uses its own migration planner and refuses unsafe alterations.
    const authMigration = await getMigrations(authOptions(pool));
    await authMigration.runMigrations();
    await client.query("GRANT USAGE ON SCHEMA public TO pi_collab_app");
    await client.query("GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO pi_collab_app");
    await client.query("CREATE SCHEMA IF NOT EXISTS collab_meta");
    await client.query("REVOKE ALL ON SCHEMA collab_meta FROM PUBLIC");
    await client.query("CREATE TABLE IF NOT EXISTS collab_meta.migrations (name text PRIMARY KEY, hash text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())");
    for (const name of (await readdir(path.resolve("db/migrations"))).filter(n => n.endsWith(".sql")).sort()) {
      const sql = await readFile(path.resolve("db/migrations", name), "utf8");
      const hash = createHash("sha256").update(sql).digest("hex");
      const previous = await client.query("SELECT hash FROM collab_meta.migrations WHERE name=$1", [name]);
      if (previous.rowCount) {
        if (previous.rows[0].hash !== hash) throw new Error(`Applied migration changed: ${name}`);
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO collab_meta.migrations(name,hash) VALUES($1,$2)", [name, hash]);
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      console.log(`Applied ${name}`);
    }
    await client.query("INSERT INTO collab.installation(singleton,bootstrap_hash) VALUES(true,$1) ON CONFLICT DO NOTHING", [createHash("sha256").update(config.bootstrapToken).digest("hex")]);
  } finally {
    await client.query("SELECT pg_advisory_unlock(82467101)");
    client.release();
    await pool.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = await localConfig();
  Object.assign(process.env, applicationEnvironment(config));
  await migrate(config);
  console.log("pi-collab database migrations are current.");
}
