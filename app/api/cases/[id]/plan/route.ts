import { sseResponse } from "@/lib/http";
import { guard } from "@/lib/ratelimit";
import { runPlanForCase } from "@/lib/service";
import { storeFromEnv } from "@/lib/store";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/cases/:id/plan — run the agent for week 1, live against Qloo, and stream it as Server-Sent Events:
 *   open → start → qloo* / llm* / tool* (as they happen) → truth_boundary? → plan (the persisted plan) | error
 * The plan is persisted before the `plan` event is sent, so a reload of GET /api/plans/:id shows the same week.
 * Rate limited before anything runs (public / judge / bench namespaces, lib/ratelimit.ts); a refusal is a 429, never a fake plan.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const g = await guard(req, "plan");
  if (g.deny) return g.deny;
  return sseResponse(async (send) => {
    const plan = await runPlanForCase({ store: storeFromEnv(), caseId: id, onEvent: (e) => send(e.type, e) });
    send("plan", { plan });
  }, g.headers);
}
