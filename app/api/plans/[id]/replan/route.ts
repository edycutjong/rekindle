import { replanPrecheck, replanWeek } from "@/lib/gate";
import { errorResponse, json, sseResponse } from "@/lib/http";
import { guard } from "@/lib/ratelimit";
import { storeFor } from "@/lib/scope";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/plans/:id/replan — week N+1 from the ratings, live (same agent loop, tools and verifier as week 1), streamed
 * as Server-Sent Events like the week-1 plan: open → start → qloo* / llm* / tool* → plan (with its diff) | error.
 * Checked before the rate limiter: an unknown week is a 404, an unrated one (or < 3 ratings) a 409, and a week that was
 * already re-planned returns that week as JSON — none of these spend an agent run or quota.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const store = storeFor(req);
  try {
    const { existing } = await replanPrecheck(store, id);
    if (existing) return json({ plan: existing, reused: true });
  } catch (e) {
    return errorResponse(e);
  }
  const g = await guard(req, "plan");
  if (g.deny) return g.deny;
  return sseResponse(async (send) => {
    const r = await replanWeek({ store, planId: id, onEvent: (e) => send(e.type, e) });
    send("plan", { plan: r.plan, reused: r.reused });
  }, g.headers);
}
