import { errorResponse, json } from "@/lib/http";
import { storeFromEnv } from "@/lib/store";

export const dynamic = "force-dynamic";

/** GET /api/plans/:id[?calls=1] — the stored week (and, on request, its Qloo call log: path, params, status, ms; never the key). */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const store = storeFromEnv();
    const plan = await store.getPlan(id);
    if (!plan) return json({ error: "plan not found" }, 404);
    const withCalls = new URL(req.url).searchParams.get("calls") === "1";
    return json({ plan, ...(withCalls ? { calls: (await store.getCalls(id))?.calls ?? [] } : {}) });
  } catch (e) {
    return errorResponse(e);
  }
}
