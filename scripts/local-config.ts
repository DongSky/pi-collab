import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, chmod, rename } from "node:fs/promises";
import path from "node:path";
import lockfile from "proper-lockfile";
import { deploymentSettings } from "./deployment-config";

export interface LocalConfig {
  version: 1;
  port: number;
  databasePort: number;
  adminPassword: string;
  appPassword: string;
  executorPassword: string;
  gatewayPassword: string;
  brokerPassword: string;
  gitPassword: string;
  gatewayPort: number;
  authSecret: string;
  bootstrapToken: string;
}

export const dataRoot = path.resolve(process.env.PI_COLLAB_DATA_DIR ?? ".local");

export async function localConfig(): Promise<LocalConfig> {
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  const file = path.join(dataRoot, "config.json");
  try {
    const config: LocalConfig = JSON.parse(await readFile(file, "utf8"));
    if (config.version !== 1) throw new Error("Unsupported local configuration version");
    if (!config.executorPassword || !config.gatewayPassword || !config.gatewayPort || !config.brokerPassword || !config.gitPassword) {
      const release = await lockfile.lock(file, { retries: { retries: 10, minTimeout: 20, maxTimeout: 250 } });
      try {
        const current: LocalConfig = JSON.parse(await readFile(file, "utf8"));
        if (!current.executorPassword || !current.gatewayPassword || !current.gatewayPort || !current.brokerPassword || !current.gitPassword) {
          current.executorPassword ||= randomBytes(32).toString("hex");
          current.gatewayPassword ||= randomBytes(32).toString("hex");
          current.gatewayPort ||= 30143;
          current.brokerPassword ||= randomBytes(32).toString("hex");
          current.gitPassword ||= randomBytes(32).toString("hex");
          const temporary = `${file}.${process.pid}.tmp`;
          await writeFile(temporary, JSON.stringify(current, null, 2) + "\n", { mode: 0o600, flag: "wx" });
          await rename(temporary, file);
        }
        return current;
      } finally { await release(); }
    }
    return config;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const secret = () => randomBytes(32).toString("hex");
  const port = (name: string, fallback: number) => {
    const value = process.env[name];
    if (value === undefined) return fallback;
    if (!/^\d+$/.test(value) || Number(value) < 1024 || Number(value) > 65535) throw new Error(`${name} must be an integer from 1024 to 65535`);
    return Number(value);
  };
  const config: LocalConfig = {
    version: 1, port: port("PI_COLLAB_PORT", 30142), databasePort: port("PI_COLLAB_DATABASE_PORT", 55432),
    adminPassword: secret(), appPassword: secret(), executorPassword: secret(), gatewayPassword: secret(), brokerPassword: secret(), gitPassword: secret(), gatewayPort: port("PI_COLLAB_GATEWAY_PORT", 30143), authSecret: secret(), bootstrapToken: secret(),
  };
  if (new Set([config.port, config.databasePort, config.gatewayPort]).size !== 3) throw new Error("Web, database and gateway ports must be different");
  try {
    await writeFile(file, JSON.stringify(config, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return localConfig();
  }
  await chmod(file, 0o600);
  return config;
}

export function executorConnectionString(config: LocalConfig, database = "pi_collab"): string {
  return `postgresql://pi_collab_executor:${encodeURIComponent(config.executorPassword)}@127.0.0.1:${config.databasePort}/${database}`;
}

export function executorEnvironment(config: LocalConfig): NodeJS.ProcessEnv {
  return {
    NODE_ENV: deploymentSettings(config).nodeEnv, PATH: process.env.PATH, LANG: process.env.LANG ?? "en_US.UTF-8",
    PI_COLLAB_DATA_DIR: dataRoot, PI_COLLAB_RUNTIME: process.env.PI_COLLAB_RUNTIME ?? "native",
    PI_COLLAB_EXECUTOR_DATABASE_URL: executorConnectionString(config),
    PI_COLLAB_EXECUTOR_CAPACITY: process.env.PI_COLLAB_EXECUTOR_CAPACITY ?? "8",
    PI_COLLAB_MODEL_GATEWAY_URL: `http://127.0.0.1:${config.gatewayPort}/v1`,
  };
}

export function gatewayConnectionString(config: LocalConfig, database = "pi_collab"): string {
  return `postgresql://pi_collab_gateway:${encodeURIComponent(config.gatewayPassword)}@127.0.0.1:${config.databasePort}/${database}`;
}

export function gatewayEnvironment(config: LocalConfig): NodeJS.ProcessEnv {
  const deployment = deploymentSettings(config);
  return {
    NODE_ENV: deployment.nodeEnv, PATH: process.env.PATH, LANG: process.env.LANG ?? "en_US.UTF-8",
    PI_COLLAB_DATA_DIR: dataRoot, PI_COLLAB_GATEWAY_PORT: String(config.gatewayPort),
    PI_COLLAB_GATEWAY_DATABASE_URL: gatewayConnectionString(config),
    PI_COLLAB_MODEL_MASTER_KEY_FILE: process.env.PI_COLLAB_MODEL_MASTER_KEY_FILE ?? path.join(dataRoot, "model-master.key"),
    PI_COLLAB_WEB_ORIGIN: deployment.webOrigin,
  };
}

export function connectionString(config: LocalConfig, admin = false, database = "pi_collab"): string {
  const user = admin ? "pi_collab_admin" : "pi_collab_app";
  const password = admin ? config.adminPassword : config.appPassword;
  return `postgresql://${user}:${password}@127.0.0.1:${config.databasePort}/${database}`;
}

/** Web processes deliberately receive no database administrator password. */
export function applicationEnvironment(config: LocalConfig): NodeJS.ProcessEnv {
  const deployment = deploymentSettings(config);
  return {
    NODE_ENV: deployment.nodeEnv,
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: process.env.LANG ?? "en_US.UTF-8",
    PI_COLLAB_MODE: "team",
    PI_WEB_ALLOWED_HOSTS: deployment.production ? new URL(deployment.webOrigin).hostname : process.env.PI_WEB_ALLOWED_HOSTS,
    PI_WEB_HOSTNAME: deployment.production ? new URL(deployment.webOrigin).hostname : process.env.PI_WEB_HOSTNAME,
    PI_COLLAB_RUNTIME: process.env.PI_COLLAB_RUNTIME ?? "native",
    PI_COLLAB_DATA_DIR: dataRoot,
    ...deployment.mail,
    PI_COLLAB_PREVIEW_ORIGIN: deployment.previewOrigin,
    DATABASE_URL: connectionString(config),
    BETTER_AUTH_SECRET: config.authSecret,
    BETTER_AUTH_URL: deployment.webOrigin,
    PI_CODING_AGENT_DIR: path.join(dataRoot, "web-pi-disabled"),
    PI_OFFLINE: "1",
    NEXT_TELEMETRY_DISABLED: "1",
  };
}

export function brokerConnectionString(config: LocalConfig, database = "pi_collab"): string {
  return `postgresql://pi_collab_broker:${encodeURIComponent(config.brokerPassword)}@127.0.0.1:${config.databasePort}/${database}`;
}
export function brokerEnvironment(config: LocalConfig): NodeJS.ProcessEnv {
  return { NODE_ENV: deploymentSettings(config).nodeEnv, PATH: process.env.PATH, LANG: process.env.LANG ?? "en_US.UTF-8", PI_COLLAB_DATA_DIR: dataRoot, PI_COLLAB_BROKER_DATABASE_URL: brokerConnectionString(config), PI_COLLAB_RESOURCE_KEY_FILE: process.env.PI_COLLAB_RESOURCE_KEY_FILE ?? path.join(dataRoot, "resource-master.key") };
}

export function gitConnectionString(config: LocalConfig, database = "pi_collab"): string {
  return `postgresql://pi_collab_git:${encodeURIComponent(config.gitPassword)}@127.0.0.1:${config.databasePort}/${database}`;
}
export function gitEnvironment(config: LocalConfig): NodeJS.ProcessEnv {
  return { NODE_ENV: deploymentSettings(config).nodeEnv, PATH: process.env.PATH, LANG: process.env.LANG ?? "en_US.UTF-8", PI_COLLAB_DATA_DIR: dataRoot, PI_COLLAB_GIT_DATABASE_URL: gitConnectionString(config), PI_COLLAB_GIT_KEY_FILE: process.env.PI_COLLAB_GIT_KEY_FILE ?? path.join(dataRoot, "git-master.key") };
}
