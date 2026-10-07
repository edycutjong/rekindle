import { errorResponse, json } from "@/lib/http";
import { storeFromEnv } from "@/lib/store";

export const dynamic = "force-dynamic";

/** GET /api/cases/:id */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const c = await storeFromEnv().getCase(id);
    return c ? json({ case: c }) : json({ error: "case not found" }, 404);
  } catch (e) {
    return errorResponse(e);
  }
}
