import { z } from "zod";
import { errorResponse, json } from "@/lib/http";
import { guard } from "@/lib/ratelimit";
import { toggleConstraints } from "@/lib/service";
import { storeFromEnv } from "@/lib/store";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const Patch = z
  .object({
    in_recovery: z.boolean().optional(),
    need_quiet: z.boolean().optional(),
    need_wheelchair: z.boolean().optional(),
    max_meters: z.number().int().min(300).max(10000).optional(),
    price_max: z.number().int().min(1).max(4).optional(),
  })
  .strict();

/**
 * POST /api/plans/:id/constraints — a constraint tab was toggled. Re-verifies only the placed outings against the new
 * case row, strikes the failures in place with their rule, refills only those slots live, and returns the new plan.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await guard(req, "toggle");
  if (g.deny) return g.deny;
  try {
    const { id } = await params;
    const patch = Patch.parse(await req.json());
    const r = await toggleConstraints({ store: storeFromEnv(), planId: id, patch });
    return json(r, 200, g.headers);
  } catch (e) {
    return errorResponse(e);
  }
}
