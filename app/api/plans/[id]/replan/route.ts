import { claimReplan, replanPrecheck, replanWeek } from "@/lib/gate";
import { errorResponse, json, sseResponse } from "@/lib/http";
import { assertOwner } from "@/lib/owner";
import { NotFound } from "@/lib/service";
import { guard } from "@/lib/ratelimit";
import { storeFor } from "@/lib/scope";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/plans/:id/replan — week N+1 from the ratings, live (same agent loop, tools and verifier as week 1), streamed
 * as Server-Sent Events like the week-1 plan: open → start → qloo* / llm* / tool* → plan (with its diff) | error.
 * Checked before the rate limiter: an unknown week is a 404, an unrated one (or < 3 ratings) a 409, and a week that was
 * already re-planned returns that week as JSON — none of these spend an agent run or quota. A week being re-planned by
 * another request (second tab, retry after a reload) is a 409 `running`; the Workbench waits and then gets that week.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const store = storeFor(req);
  let parent;
  try {
    const pre = await replanPrecheck(store, id);
    if (pre.existing) return json({ plan: pre.existing, reused: true });
    parent = pre.parent;
    const c = await store.getCase(parent.case_id);
    // a2a r01: fail closed like assertPlanOwner — a week whose case is gone is a 404 before any quota or claim marker
    if (!c) throw new NotFound(`case ${parent.case_id} not found`);
    assertOwner(req, c);
  } catch (e) {
    return errorResponse(e);
  }
  const g = await guard(req, "plan");
  if (g.deny) return g.deny;
  // one re-plan per week: a create-only marker; a concurrent request gets 409 running (or the week once it is stored)
  let claimed;
  try {
    const c = await claimReplan(store, parent);
    if ("plan" in c) return json({ plan: c.plan, reused: true }, 200, g.headers);
    claimed = c.claimed;
  } catch (e) {
    return errorResponse(e);
  }
  return sseResponse(async (send) => {
    const r = await replanWeek({ store, planId: id, claimed, onEvent: (e) => send(e.type, e) });
    send("plan", { plan: r.plan, reused: r.reused });
  }, g.headers);
}
