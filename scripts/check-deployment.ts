import { verifyRelease } from "./release.mjs";
import { parseArgs } from "node:util";
import nodemailer from "nodemailer";
import { localConfig, dataRoot } from "./local-config";
import { deploymentSettings } from "./deployment-config";
import { smtpOptions } from "../lib/collab/mail";
import { assertPrivateFile } from "./operations-core";
const { values } = parseArgs({ options: { smtp: { type: "boolean" } } });
try {
  const config = await localConfig(), settings = deploymentSettings(config);
  if (!settings.production) throw new Error("Set PI_COLLAB_DEPLOYMENT=production and load the private deployment environment");
  await assertPrivateFile(`${dataRoot}/config.json`);
  let release = true;
  try { await verifyRelease(); } catch { release = false; }
  let smtp = "not-tested";
  if (values.smtp) {
    const transport = nodemailer.createTransport(smtpOptions({ ...process.env, NODE_ENV: "production" }));
    try { await transport.verify(); smtp = "connection-and-authentication-verified"; }
    catch { throw new Error("SMTP connection/authentication failed; credentials and server responses are omitted"); }
    finally { transport.close(); }
  }
  console.log(JSON.stringify({ configuration: "valid", runtime: process.env.PI_COLLAB_RUNTIME ?? "native", release, webOrigin: settings.webOrigin, previewOrigin: settings.previewOrigin, smtp, delivery: "not-tested", publicIngress: "not-tested" }));
  if (!release) process.exitCode = 1;
} catch (error) { console.error(error instanceof Error ? error.message : "Deployment check failed"); process.exitCode = 1; }
