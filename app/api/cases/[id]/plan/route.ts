import { z } from "zod";
import { json, sseResponse } from "@/lib/http";
import { guard } from "@/lib/ratelimit";
import { storeFor } from "@/lib/scope";
import { runPlanForCase } from "@/lib/service";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Optional body. `bench` is honoured only in the bench namespace; `fault` is the labelled Qloo-outage demo on /judge. */
const Body = z
  .object({
    bench: z.enum(["B", "B-", "B-4"]).optional(),
    fault: z.literal("qloo_unreachable").optional(),
  })
  .strict();

/**
 * POST /api/cases/:id/plan — run the agent for week 1, live against Qloo, and stream it as Server-Sent Events:
 *   open → start → qloo* / llm* / tool* (as they happen) → truth_boundary? → plan (the persisted plan) | error
 * The plan is persisted before the `plan` event is sent, so a reload of GET /api/plans/:id shows the same week.
 * Rate limited before anything runs (public / judge / bench namespaces, lib/ratelimit.ts); a refusal is a 429, never a fake plan.
 * The outage demo (`fault`) sends no Qloo request and calls no LLM, so it is limited like a toggle, not like a plan.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const raw = await req.text();
  const parsed = Body.safeParse(raw.trim() ? safeJson(raw) : {});
  if (!parsed.success) return json({ error: "invalid body", issues: parsed.error.issues.map((i) => i.message) }, 400);
  const { bench, fault } = parsed.data;
  if (bench && fault) return json({ error: "bench and fault cannot be combined" }, 400);
  const g = await guard(req, fault ? "toggle" : "plan");
  if (g.deny) return g.deny;
  if (bench && g.ns !== "bench") return json({ error: "bench arms need the bench token" }, 403);
  return sseResponse(async (send) => {
    const plan = await runPlanForCase({ store: storeFor(req), caseId: id, bench, fault, onEvent: (e) => send(e.type, e) });
    send("plan", { plan });
  }, g.headers);
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
