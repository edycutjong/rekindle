/** Small helpers for the route handlers: JSON responses, error mapping, and a Server-Sent Events stream. */
import { ZodError } from "zod";
import { Forbidden } from "./owner";
import { BadInput } from "./intake";
import { Conflict, NotFound } from "./service";
import { StoreUnavailable, storeDegraded } from "./store";

/** a2a r06: set while this instance runs in safe mode (lib/store.ts FailoverStore); the Workbench shows its banner */
export const DEGRADED_HEADER = "x-store-degraded";
const degradedHeaders = (): Record<string, string> => (storeDegraded() ? { [DEGRADED_HEADER]: "1" } : {});

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(body, { status, headers: { ...headers, ...degradedHeaders(), "cache-control": "no-store" } });

/** the 503 body when saved weeks cannot be read (never a 500, never a fake 404) */
export const STORE_UNAVAILABLE_MESSAGE = "Saved weeks are unavailable right now (storage). Planning a new fictional week still runs live.";

export function errorResponse(e: unknown): Response {
  if (e instanceof NotFound) return json({ error: e.message }, 404);
  if (e instanceof BadInput) return json({ error: e.message }, 400);
  if (e instanceof Forbidden) return json({ error: e.message, read_only: true }, 403);
  if (e instanceof Conflict) return json({ error: e.message, ...e.body }, 409);
  // a malformed body (req.json() throws SyntaxError) is the client's error, not the server's
  if (e instanceof SyntaxError) return json({ error: "invalid JSON" }, 400);
  if (e instanceof ZodError) return json({ error: "invalid input", issues: e.issues.map((i) => ({ path: i.path.join("."), message: i.message })) }, 400);
  if (e instanceof Error && e.message === "invalid id") return json({ error: "invalid id" }, 400);
  if (e instanceof StoreUnavailable) return json({ error: STORE_UNAVAILABLE_MESSAGE, store: "unavailable" }, 503, { "retry-after": "60" });
  console.error(e);
  return json({ error: "internal error" }, 500);
}

export type Send = (event: string, data: unknown) => void;

/** One SSE frame per event: `event: <type>` + `data: <json>`. The stream closes when `run` settles. */
export function sseResponse(run: (send: Send) => Promise<void>, extraHeaders: Record<string, string> = {}): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const send: Send = (event, data) => {
        if (!open) return;
        try {
          controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          open = false; // client went away; the run still completes and is persisted
        }
      };
      send("open", { at: new Date().toISOString() });
      try {
        await run(send);
      } catch (e) {
        const r = errorResponse(e);
        send("error", { status: r.status, ...(await r.json()) });
      } finally {
        if (open) controller.close();
      }
    },
  });
  return new Response(stream, { headers: { ...extraHeaders, ...degradedHeaders(), "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store, no-transform", connection: "keep-alive", "x-accel-buffering": "no" } });
}

/** Parse an SSE body into {event, data} frames (tests and scripts). */
export function parseSse(text: string): { event: string; data: unknown }[] {
  return text
    .split("\n\n")
    .filter((f) => f.trim())
    .map((f) => {
      const event = /^event: (.*)$/m.exec(f)?.[1] ?? "message";
      const data = /^data: (.*)$/m.exec(f)?.[1];
      return { event, data: data ? JSON.parse(data) : null };
    });
}
