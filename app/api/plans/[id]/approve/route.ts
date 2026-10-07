import { approveWeek } from "@/lib/gate";
import { errorResponse, json } from "@/lib/http";
import { assertPlanOwner } from "@/lib/owner";
import { guard } from "@/lib/ratelimit";
import { storeFor } from "@/lib/scope";

export const dynamic = "force-dynamic";

/** POST /api/plans/:id/approve — the clinician gate (I4): stamps every card on the draft week and locks it. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    await assertPlanOwner(req, storeFor(req), id);
    const g = await guard(req, "write");
    if (g.deny) return g.deny;
    return json({ plan: await approveWeek({ store: storeFor(req), planId: id }) }, 200, g.headers);
  } catch (e) {
    return errorResponse(e);
  }
}
