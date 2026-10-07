import { approveWeek } from "@/lib/gate";
import { errorResponse, json } from "@/lib/http";
import { guard } from "@/lib/ratelimit";
import { storeFromEnv } from "@/lib/store";

export const dynamic = "force-dynamic";

/** POST /api/plans/:id/approve — the clinician gate (I4): stamps every card on the draft week and locks it. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await guard(req, "write");
  if (g.deny) return g.deny;
  try {
    const { id } = await params;
    return json({ plan: await approveWeek({ store: storeFromEnv(), planId: id }) }, 200, g.headers);
  } catch (e) {
    return errorResponse(e);
  }
}
