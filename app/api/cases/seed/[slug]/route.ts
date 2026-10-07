import { errorResponse, json } from "@/lib/http";
import { guard } from "@/lib/ratelimit";
import { caseFromSeed, SEEDS } from "@/lib/service";
import { storeFor } from "@/lib/scope";

export const dynamic = "force-dynamic";

/**
 * POST /api/cases/seed/maya — clone a fictional seeded profile (inputs only) into a fresh case for this visitor.
 * `?preset=recovery` clones it with "in recovery" already on (the /judge REVIEW state: the alcohol screen's REVIEW
 * signals only apply to an in-recovery case).
 */
export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const g = await guard(req, "write");
  if (g.deny) return g.deny;
  try {
    const { slug } = await params;
    const seeded = caseFromSeed(slug);
    if (!seeded) return json({ error: `unknown seed "${slug}"`, seeds: SEEDS.map((s) => s.slug) }, 404);
    const preset = new URL(req.url).searchParams.get("preset");
    if (preset && preset !== "recovery") return json({ error: `unknown preset "${preset}"` }, 400);
    const doc = preset === "recovery" ? { ...seeded, in_recovery: true } : seeded;
    await storeFor(req).putCase(doc);
    return json({ case: doc }, 201);
  } catch (e) {
    return errorResponse(e);
  }
}
