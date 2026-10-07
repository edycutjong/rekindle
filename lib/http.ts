/** Small helpers for the route handlers: JSON responses, error mapping, and a Server-Sent Events stream. */
import { ZodError } from "zod";
import { Conflict, NotFound } from "./service";

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(body, { status, headers: { ...headers, "cache-control": "no-store" } });

export function errorResponse(e: unknown): Response {
  if (e instanceof NotFound) return json({ error: e.message }, 404);
  if (e instanceof Conflict) return json({ error: e.message }, 409);
  if (e instanceof ZodError) return json({ error: "invalid input", issues: e.issues.map((i) => ({ path: i.path.join("."), message: i.message })) }, 400);
  if (e instanceof Error && e.message === "invalid id") return json({ error: "invalid id" }, 400);
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
  return new Response(stream, { headers: { ...extraHeaders, "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store, no-transform", connection: "keep-alive", "x-accel-buffering": "no" } });
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
