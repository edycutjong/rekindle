import { errorResponse, json } from "@/lib/http";
import { storeFor } from "@/lib/scope";

export const dynamic = "force-dynamic";

/** GET /api/cases/:id */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const c = await storeFor(req).getCase(id);
    return c ? json({ case: c }) : json({ error: "case not found" }, 404);
  } catch (e) {
    return errorResponse(e);
  }
}
