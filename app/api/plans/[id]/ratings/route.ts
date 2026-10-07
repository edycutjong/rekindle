import { z } from "zod";
import { rateWeek } from "@/lib/gate";
import { errorResponse, json } from "@/lib/http";
import { guard } from "@/lib/ratelimit";
import { storeFromEnv } from "@/lib/store";

export const dynamic = "force-dynamic";

const score = z.number().int().min(0).max(10);
const Body = z.object({ ratings: z.array(z.object({ card_id: z.string(), pleasure: score, mastery: score }).strict()).min(1).max(7) }).strict();

/** POST /api/plans/:id/ratings — pleasure / mastery 0–10 for approved cards of an approved week. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await guard(req, "write");
  if (g.deny) return g.deny;
  try {
    const { id } = await params;
    const { ratings } = Body.parse(await req.json());
    return json({ plan: await rateWeek({ store: storeFromEnv(), planId: id, ratings }) }, 200, g.headers);
  } catch (e) {
    return errorResponse(e);
  }
}
