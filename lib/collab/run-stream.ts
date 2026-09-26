import { auth } from "./auth";
import { runFeed } from "./runs";
import { DomainError } from "./policy";

/** Reauthorize every batch, including an otherwise idle stream. */
export function streamRunEvents(request: Request, projectId: string, initialCursor: string): Response {
  const encoder = new TextEncoder();
  let closed = false;
  let cancelled = false;
  const abort = () => { closed = true; };
  request.signal.addEventListener("abort", abort, { once: true });
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let cursor = initialCursor;
      let authorizationVersion: string | undefined;
      const send = (event: string, data: unknown, id?: string) => {
        if (!closed) controller.enqueue(encoder.encode(`${id === undefined ? "" : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      try {
        while (!closed) {
          const session = await auth().api.getSession({ headers: request.headers });
          if (!session) { send("access_revoked", { reason: "session_expired" }); break; }
          const feed = await runFeed(session.user.id, projectId, cursor);
          if (authorizationVersion && feed.authorizationVersion !== authorizationVersion) { send("access_revoked", { reason: "authorization_changed" }); break; }
          authorizationVersion = feed.authorizationVersion;
          // Slow consumers still undergo project authorization on every iteration.
          if ((controller.desiredSize ?? 0) <= 0) { await new Promise(resolve => setTimeout(resolve, 1000)); continue; }
          if (feed.reset) { send("snapshot", { runs: feed.snapshot, cursor: feed.cursor }, feed.cursor); cursor = feed.cursor; }
          for (const event of feed.events) {
            send("run_event", event, event.sequence); cursor = event.sequence;
            if ((controller.desiredSize ?? 0) <= 0) break;
          }
          if (!closed && !feed.events.length) controller.enqueue(encoder.encode(": heartbeat\n\n"));
          // Poll durable state; notifications are only an optimization, never authority.
          await new Promise(resolve => setTimeout(resolve, feed.events.length === 100 && (controller.desiredSize ?? 0) > 0 ? 10 : 1000));
        }
      } catch (error) {
        // Do not leak backend details or stale project data after authorization changes.
        if (error instanceof DomainError && [401, 403, 404].includes(error.status)) send("access_revoked", { reason: "project_access_revoked" });
        else send("stream_closed", { reconnect: true });
      } finally {
        request.signal.removeEventListener("abort", abort);
        closed = true;
        if (!cancelled) controller.close();
      }
    },
    cancel() { cancelled = true; closed = true; request.signal.removeEventListener("abort", abort); },
  }, new ByteLengthQueuingStrategy({ highWaterMark: 128 * 1024 }));
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
}
