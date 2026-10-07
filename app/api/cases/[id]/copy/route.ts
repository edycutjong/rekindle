import { errorResponse, json } from "@/lib/http";
import { ownerForNewCase } from "@/lib/owner";
import { guard } from "@/lib/ratelimit";
import { storeFor } from "@/lib/scope";
import { CaseDoc, newId } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * POST /api/cases/:id/copy — "Copy this case": a visitor viewing someone else's (read-only) case gets a fresh case with
 * the same fictional intake (loves, point, energy, constraints), owned by them. No plan is copied: week 1 runs live.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const store = storeFor(req);
    const src = await store.getCase(id);
    if (!src) return json({ error: "case not found" }, 404);
    const g = await guard(req, "write");
    if (g.deny) return g.deny;
    const owner = ownerForNewCase(req);
    const doc = CaseDoc.parse({ ...src, id: newId(), created_at: new Date().toISOString(), owner_hash: owner.owner_hash, loves: src.loves.map((l) => ({ ...l, id: newId() })) });
    await store.putCase(doc);
    return json({ case: doc, copied_from: src.id }, 201, { ...g.headers, ...owner.setCookie });
  } catch (e) {
    return errorResponse(e);
  }
}
