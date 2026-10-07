import { errorResponse, json } from "@/lib/http";
import { caseFromSeed, SEEDS } from "@/lib/service";
import { storeFromEnv } from "@/lib/store";

export const dynamic = "force-dynamic";

/** POST /api/cases/seed/maya — clone a fictional seeded profile (inputs only) into a fresh case for this visitor. */
export async function POST(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await params;
    const doc = caseFromSeed(slug);
    if (!doc) return json({ error: `unknown seed "${slug}"`, seeds: SEEDS.map((s) => s.slug) }, 404);
    await storeFromEnv().putCase(doc);
    return json({ case: doc }, 201);
  } catch (e) {
    return errorResponse(e);
  }
}
