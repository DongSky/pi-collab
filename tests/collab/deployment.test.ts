import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:tls";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { deploymentSettings } from "../../scripts/deployment-config";
import { applicationEnvironment, executorEnvironment, gatewayEnvironment, brokerEnvironment, gitEnvironment, type LocalConfig } from "../../scripts/local-config";
import { smtpOptions } from "../../lib/collab/mail";
const exec = promisify(execFile), ports = { port: 30142, gatewayPort: 30143 };
const production = { PI_COLLAB_DEPLOYMENT: "production", PI_COLLAB_DATA_DIR: "/srv/pi-collab", PI_COLLAB_PUBLIC_ORIGIN: "https://collab.example.com", PI_COLLAB_PREVIEW_ORIGIN: "https://preview.example.net", SMTP_URL: "smtps://fixture:private@smtp.example.com:465", SMTP_FROM: "Collab <collab@example.com>" };

test("local defaults stay native/file and production origins, SMTP and persistent configuration are explicit", () => {
  const local = deploymentSettings(ports, { SMTP_URL: production.SMTP_URL });
  assert.equal(local.production, false); assert.deepEqual(local.mail, { PI_COLLAB_MAIL_TRANSPORT: "file" });
  const configured = deploymentSettings(ports, production); assert.equal(configured.webOrigin, production.PI_COLLAB_PUBLIC_ORIGIN); assert.equal(configured.mail.SMTP_URL, production.SMTP_URL);
  for (const changes of [{ PI_COLLAB_DATA_DIR: ".local" }, { PI_COLLAB_PUBLIC_ORIGIN: "http://example.com" }, { PI_COLLAB_PUBLIC_ORIGIN: "https://user:secret@example.com" }, { PI_COLLAB_PREVIEW_ORIGIN: "https://collab.example.com:444" }, { SMTP_URL: "smtp://example.com?ignoreTLS=true" }, { SMTP_FROM: "from\r\nto" }]) assert.throws(() => deploymentSettings(ports, { ...production, ...changes }));
  assert.equal(smtpOptions({ SMTP_URL: "smtp://localhost:587", NODE_ENV: "production" }).requireTLS, true);
  assert.throws(() => smtpOptions({ SMTP_URL: "smtp://localhost?tls.rejectUnauthorized=false" }));
});

test("public identity, previews and SMTP reach their own services without leaking SMTP credentials to workers", () => {
  const previous = { ...process.env };
  Object.assign(process.env, production);
  try {
    const config: LocalConfig = { ...ports, version: 1, databasePort: 55432, adminPassword: "admin", appPassword: "app", executorPassword: "executor", gatewayPassword: "gateway", brokerPassword: "broker", gitPassword: "git", authSecret: "auth", bootstrapToken: "bootstrap" };
    const files = { PI_COLLAB_MODEL_MASTER_KEY_FILE: "/private-keys/model", PI_COLLAB_RESOURCE_KEY_FILE: "/private-keys/resource", PI_COLLAB_GIT_KEY_FILE: "/private-keys/git" };
    Object.assign(process.env, files, { PI_COLLAB_EXECUTOR_CAPACITY: "12" });
    const web = applicationEnvironment(config), gateway = gatewayEnvironment(config);
    const broker = brokerEnvironment(config), git = gitEnvironment(config), executor = executorEnvironment(config);
    assert.equal(executor.PI_COLLAB_EXECUTOR_CAPACITY, "12");
    assert.equal(gateway.PI_COLLAB_MODEL_MASTER_KEY_FILE, files.PI_COLLAB_MODEL_MASTER_KEY_FILE);
    assert.equal(broker.PI_COLLAB_RESOURCE_KEY_FILE, files.PI_COLLAB_RESOURCE_KEY_FILE);
    assert.equal(git.PI_COLLAB_GIT_KEY_FILE, files.PI_COLLAB_GIT_KEY_FILE);
    for (const env of [gateway,broker,git]) assert.equal(env.NODE_ENV, "production");
    for (const env of [web,executor]) for (const name of Object.keys(files)) assert.equal(env[name], undefined);
    assert.equal(gateway.PI_COLLAB_RESOURCE_KEY_FILE, undefined); assert.equal(broker.PI_COLLAB_MODEL_MASTER_KEY_FILE, undefined);
    assert.equal(web.NODE_ENV, "production"); assert.equal(web.BETTER_AUTH_URL, production.PI_COLLAB_PUBLIC_ORIGIN); assert.equal(web.SMTP_URL, production.SMTP_URL);
    assert.equal(web.PI_COLLAB_PREVIEW_ORIGIN, production.PI_COLLAB_PREVIEW_ORIGIN); assert.equal(gateway.PI_COLLAB_WEB_ORIGIN, production.PI_COLLAB_PUBLIC_ORIGIN);
    for (const env of [gateway, executorEnvironment(config), brokerEnvironment(config), gitEnvironment(config)]) assert.equal(JSON.stringify(env).includes(production.SMTP_URL), false);
    assert.equal(web.DATABASE_URL?.includes("admin"), false);
  } finally { for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; Object.assign(process.env, previous); }
});

test("production SMTP delivers through certificate-verified local TLS with exact envelope and content", { timeout: 20000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-collab-smtp-"));
  const key = path.join(root, "key.pem"), cert = path.join(root, "cert.pem");
  let server: ReturnType<typeof createServer> | undefined;
  const envelopes: string[] = [], bodies: string[] = [];
  try {
    await exec("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { timeout: 10000 });
    server = createServer({ key: await readFile(key), cert: await readFile(cert) }, socket => {
      socket.setEncoding("utf8"); socket.write("220 localhost fixture\r\n"); let buffer = "", body = "", data = false;
      socket.on("data", chunk => {
        buffer += chunk;
        while (buffer.includes("\r\n")) {
          const end = buffer.indexOf("\r\n"), line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          if (data) { if (line === ".") { bodies.push(body); body = ""; data = false; socket.write("250 queued\r\n"); } else body += line + "\n"; }
          else if (/^EHLO/.test(line)) socket.write("250-localhost\r\n250 AUTH PLAIN\r\n");
          else if (/^AUTH PLAIN/.test(line)) socket.write("235 authenticated\r\n");
          else if (/^(MAIL FROM|RCPT TO)/.test(line)) { envelopes.push(line); socket.write("250 accepted\r\n"); }
          else if (line === "DATA") { data = true; socket.write("354 send data\r\n"); }
          else if (line === "QUIT") socket.end("221 bye\r\n");
          else socket.write("250 ok\r\n");
        }
      });
      socket.on("error", () => {});
    });
    await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    await exec(process.execPath, ["--import", "tsx", "tests/collab/fixtures/deliver-mail.ts"], {
      timeout: 12000, env: { PATH: process.env.PATH, NODE_EXTRA_CA_CERTS: cert, NODE_ENV: "production", PI_COLLAB_MAIL_TRANSPORT: "smtp", SMTP_URL: `smtps://fixture:fixture@localhost:${port}`, SMTP_FROM: "sender@test.invalid" },
    });
    assert.deepEqual(envelopes, ["MAIL FROM:<sender@test.invalid>", "RCPT TO:<recipient@test.invalid>"]);
    assert.equal(bodies.length, 1); assert.match(bodies[0], /Fixed local delivery fixture/); assert.match(bodies[0], /Subject: Collab TLS fixture/);
  } finally { if (server) await new Promise<void>(resolve => server!.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});
