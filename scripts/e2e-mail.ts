import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createServer, type TLSSocket } from "node:tls";
import { promisify } from "node:util";

// Production browser fixtures use real, certificate-verified SMTP. Never relax
// the application's production ban on the development file transport.
export async function startMailFixture(root: string) {
  const key = path.join(root, "smtp-key.pem"), cert = path.join(root, "smtp-cert.pem");
  const mailbox = path.join(root, "mailbox");
  await mkdir(mailbox, { mode: 0o700 });
  await promisify(execFile)("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { timeout: 10000 });
  const sockets = new Set<TLSSocket>();
  const server = createServer({ key: await readFile(key), cert: await readFile(cert) }, socket => {
    sockets.add(socket); socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => {}); socket.setEncoding("utf8");
    socket.write("220 localhost browser fixture\r\n");
    let buffer = "", message = "", data = false;
    socket.on("data", chunk => {
      buffer += chunk;
      while (buffer.includes("\r\n")) {
        const end = buffer.indexOf("\r\n"), line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (data) {
          if (line !== ".") { message += line.replace(/^\.\./, ".") + "\r\n"; continue; }
          data = false;
          const boundary = message.indexOf("\r\n\r\n"), headers = message.slice(0, boundary), body = message.slice(boundary + 4);
          const encoding = headers.match(/^Content-Transfer-Encoding:\s*(\S+)/im)?.[1].toLowerCase();
          const text = encoding === "base64" ? Buffer.from(body, "base64").toString("utf8")
            : encoding === "quoted-printable" ? Buffer.from(body.replace(/=\r\n/g, "").replace(/=([\da-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))), "binary").toString("utf8") : body;
          message = "";
          void writeFile(path.join(mailbox, `${randomUUID()}.json`), JSON.stringify({ text }), { mode: 0o600, flag: "wx" })
            .then(() => socket.write("250 queued\r\n"), () => socket.end("451 fixture write failed\r\n"));
        } else if (/^(EHLO|HELO)\b/.test(line)) socket.write("250 localhost\r\n");
        else if (/^(MAIL FROM|RCPT TO):/.test(line)) socket.write("250 accepted\r\n");
        else if (line === "DATA") { data = true; socket.write("354 send data\r\n"); }
        else if (line === "QUIT") socket.end("221 bye\r\n");
        else socket.write("250 ok\r\n");
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = (server.address() as { port: number }).port;
  return {
    env: { PI_COLLAB_MAIL_TRANSPORT: "smtp", SMTP_URL: `smtps://localhost:${port}`, SMTP_FROM: "fixture@test.invalid", NODE_EXTRA_CA_CERTS: cert },
    async close() { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}
