import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import type { ServiceResponse } from "./service-preview-schema";
export function servicePreviewHandler(pool: Pool, webOrigin: string) {
  let active = 0;
  return async (req: IncomingMessage, res: ServerResponse) => {
    if (!req.url?.startsWith("/service/")) return false;
    const match = /^\/service\/([a-f0-9]{64})(\/[^#]*)$/.exec(req.url), prefix = match ? `/service/${match[1]}/` : "/service/";
    const reply = (status: number, body: Buffer | string, type = "text/plain; charset=utf-8", location?: string) => {
      res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS", "Access-Control-Allow-Headers": "content-type", "Cross-Origin-Resource-Policy": "cross-origin",
        "Content-Security-Policy": `sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-src 'none'; frame-ancestors ${new URL(webOrigin).origin}`,
        "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()", ...(location ? { Location: location } : {}) }); res.end(req.method === "HEAD" ? undefined : body);
    };
    if (!match || active >= 32 || !["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(req.method ?? "")) { reply(active >= 32 ? 429 : 404, "Service preview unavailable"); return true; }
    active++;
    try {
      const digest = createHash("sha256").update(match[1]).digest("hex"), chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 1024 * 1024) { reply(413, "Preview request too large"); return true; } chunks.push(chunk); }
      // Only these application fields cross the boundary. Browser cookies,
      // authorization, forwarding headers and the viewer token never reach code.
      if (req.method === "OPTIONS") {
        const access = (await pool.query("SELECT collab_gateway.service_access($1) AS id", [digest])).rows[0].id;
        reply(access ? 204 : 404, ""); return true;
      }
      const id = (await pool.query("SELECT collab_gateway.service_enqueue($1,$2,$3,$4,$5) AS id", [digest,req.method,match[2],String(req.headers["content-type"] ?? "application/octet-stream").slice(0,200),Buffer.concat(chunks).toString("base64")])).rows[0].id;
      if (!id) { reply(404, "Service preview unavailable"); return true; }
      const deadline = Date.now() + 12000; let value: ServiceResponse | null = null;
      while (Date.now() < deadline && !res.destroyed) {
        value = (await pool.query("SELECT collab_gateway.service_response($1,$2) AS result", [digest,id])).rows[0].result;
        if (value) break; await new Promise(r => setTimeout(r, 100));
      }
      if (res.destroyed) return true;
      if (!value) { reply(504, "Preview request timed out; mutations are not retried"); return true; }
      let location: string | undefined;
      if (value.location) {
        if (!value.location.startsWith("/") || value.location.startsWith("//") || /[\x00-\x20\x7f\\]/.test(value.location)) { reply(502, "Preview redirect unavailable"); return true; }
        location = prefix + value.location.slice(1);
      }
      reply(value.status, Buffer.from(value.body, "base64"), value.contentType, location);
    } catch { if (!res.headersSent) reply(503, "Service preview temporarily unavailable"); else res.destroy(); }
    finally { active--; }
    return true;
  };
}
