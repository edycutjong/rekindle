import { errorResponse, json } from "@/lib/http";
import { guard } from "@/lib/ratelimit";
import { caseFromSeed, SEEDS } from "@/lib/service";
import { storeFor } from "@/lib/scope";

export const dynamic = "force-dynamic";

/** POST /api/cases/seed/maya — clone a fictional seeded profile (inputs only) into a fresh case for this visitor. */
export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const g = await guard(req, "write");
  if (g.deny) return g.deny;
  try {
    const { slug } = await params;
    const doc = caseFromSeed(slug);
    if (!doc) return json({ error: `unknown seed "${slug}"`, seeds: SEEDS.map((s) => s.slug) }, 404);
    await storeFor(req).putCase(doc);
    return json({ case: doc }, 201);
  } catch (e) {
    return errorResponse(e);
  }
}
