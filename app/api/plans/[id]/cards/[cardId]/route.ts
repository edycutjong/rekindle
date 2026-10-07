import { z } from "zod";
import { actOnCard } from "@/lib/gate";
import { errorResponse, json } from "@/lib/http";
import { guard } from "@/lib/ratelimit";
import { storeFromEnv } from "@/lib/store";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const Body = z.object({ action: z.enum(["approve", "unapprove", "swap", "remove"]) }).strict();

/**
 * PATCH /api/plans/:id/cards/:cardId — one clinician action on one card of a draft week: approve / unapprove / remove,
 * or swap (re-runs that one slot live through the same tool + verifier, with everything already on or struck from the
 * sheet excluded). Swap costs Qloo calls, so it is limited like a constraint toggle; the others are cheap writes.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string; cardId: string }> }) {
  try {
    const { id, cardId } = await params;
    const { action } = Body.parse(await req.json());
    const g = await guard(req, action === "swap" ? "toggle" : "write");
    if (g.deny) return g.deny;
    const r = await actOnCard({ store: storeFromEnv(), planId: id, cardId, action });
    return json(r, 200, g.headers);
  } catch (e) {
    return errorResponse(e);
  }
}
