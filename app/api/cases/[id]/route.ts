import { errorResponse, json } from "@/lib/http";
import { guard } from "@/lib/ratelimit";
import { storeFor } from "@/lib/scope";

export const dynamic = "force-dynamic";

/** GET /api/cases/:id — the stored case: loves, neighbourhood point, energy and constraints. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  // a2a r02: metered before any Blob read (each read is a billed op on Vercel Hobby); a refusal costs zero ops
  const g = await guard(req, "read");
  if (g.deny) return g.deny;
  try {
    const { id } = await params;
    const c = await storeFor(req).getCase(id);
    return c ? json({ case: c }, 200, g.headers) : json({ error: "case not found" }, 404, g.headers);
  } catch (e) {
    return errorResponse(e);
  }
}
