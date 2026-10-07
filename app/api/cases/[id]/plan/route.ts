import { sseResponse } from "@/lib/http";
import { runPlanForCase } from "@/lib/service";
import { storeFromEnv } from "@/lib/store";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/cases/:id/plan — run the agent for week 1, live against Qloo, and stream it as Server-Sent Events:
 *   open → start → qloo* / llm* / tool* (as they happen) → truth_boundary? → plan (the persisted plan) | error
 * The plan is persisted before the `plan` event is sent, so a reload of GET /api/plans/:id shows the same week.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return sseResponse(async (send) => {
    const plan = await runPlanForCase({ store: storeFromEnv(), caseId: id, onEvent: (e) => send(e.type, e) });
    send("plan", { plan });
  });
}
