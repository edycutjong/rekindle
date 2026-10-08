import { errorResponse, json } from "@/lib/http";
import { guard } from "@/lib/ratelimit";
import { storeFor } from "@/lib/scope";

export const dynamic = "force-dynamic";

/** GET /api/plans/:id[?calls=1] — the stored week (and, on request, its Qloo call log: path, params, status, ms; never the key). */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  // a2a r02: metered before any Blob read (each read is a billed op on Vercel Hobby); a refusal costs zero ops
  const g = await guard(req, "read");
  if (g.deny) return g.deny;
  try {
    const { id } = await params;
    const store = storeFor(req);
    const plan = await store.getPlan(id);
    if (!plan) return json({ error: "plan not found" }, 404, g.headers);
    const withCalls = new URL(req.url).searchParams.get("calls") === "1";
    return json({ plan, ...(withCalls ? { calls: (await store.getCalls(id))?.calls ?? [] } : {}) }, 200, g.headers);
  } catch (e) {
    return errorResponse(e);
  }
}
