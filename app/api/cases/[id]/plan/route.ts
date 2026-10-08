import { z } from "zod";
import { errorResponse, json, sseResponse } from "@/lib/http";
import { assertCaseOwner } from "@/lib/owner";
import { classify, guard } from "@/lib/ratelimit";
import { storeFor } from "@/lib/scope";
import { storeDegraded } from "@/lib/store";
import { claimWeekOne, planRunState, runPlanForCase } from "@/lib/service";

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
 * One run per case: a case that already has its week 1 gets that stored plan back as JSON, and a case whose run is in
 * flight gets a 409 — both before the rate limiter, so neither costs quota.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const raw = await req.text();
  const parsed = Body.safeParse(raw.trim() ? safeJson(raw) : {});
  if (!parsed.success) return json({ error: "invalid body", issues: parsed.error.issues.map((i) => i.message) }, 400);
  const { bench, fault } = parsed.data;
  if (bench && fault) return json({ error: "bench and fault cannot be combined" }, 400);
  if (bench && classify(req) !== "bench") return json({ error: "bench arms need the bench token" }, 403);
  // one week-1 run per case, checked before the rate limiter: a reload or a second tab never spends another run
  const state = await planRunState(storeFor(req), id);
  if (state && "plan" in state) return json({ plan: state.plan, reused: true });
  if (state) return json({ error: "this case is already being planned (another tab or a reload); its week will be saved when the run ends", running: true, started_at: state.running.started_at }, 409);
  try {
    await assertCaseOwner(req, storeFor(req), id);
  } catch (e) {
    return errorResponse(e);
  }
  const g = await guard(req, fault ? "toggle" : "plan");
  if (g.deny) return g.deny;
  if (bench && g.ns !== "bench") return json({ error: "bench arms need the bench token" }, 403);
  // the precheck above is a read; this create-only marker write is what stops two concurrent POSTs both running
  let claimed;
  try {
    const c = await claimWeekOne(storeFor(req), id);
    if ("plan" in c) return json({ plan: c.plan, reused: true }, 200, g.headers);
    claimed = c.claimed;
  } catch (e) {
    return errorResponse(e);
  }
  return sseResponse(async (send) => {
    const plan = await runPlanForCase({ store: storeFor(req), caseId: id, bench, fault, claimed, onEvent: (e) => send(e.type, e) });
    // a2a r06: `degraded` = the store is down and this week lives in this instance's memory (the Workbench banner)
    send("plan", { plan, degraded: storeDegraded() });
  }, g.headers);
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
