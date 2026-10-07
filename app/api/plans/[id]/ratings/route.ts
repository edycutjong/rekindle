import { z } from "zod";
import { rateWeek } from "@/lib/gate";
import { errorResponse, json } from "@/lib/http";
import { assertPlanOwner } from "@/lib/owner";
import { guard } from "@/lib/ratelimit";
import { storeFor } from "@/lib/scope";

export const dynamic = "force-dynamic";

const score = z.number().int().min(0).max(10);
const Body = z.object({ ratings: z.array(z.object({ card_id: z.string(), pleasure: score, mastery: score.nullable().optional() }).strict()).min(1).max(7) }).strict();

/** POST /api/plans/:id/ratings — pleasure / mastery 0–10 for approved cards of an approved week. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { ratings } = Body.parse(await req.json());
    await assertPlanOwner(req, storeFor(req), id);
    const g = await guard(req, "write");
    if (g.deny) return g.deny;
    return json({ plan: await rateWeek({ store: storeFor(req), planId: id, ratings }) }, 200, g.headers);
  } catch (e) {
    return errorResponse(e);
  }
}
