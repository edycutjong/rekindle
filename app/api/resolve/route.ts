import { z } from "zod";
import { errorResponse, json } from "@/lib/http";
import { qlooFromEnv } from "@/lib/qloo";
import { LOVE_KINDS, resolveLove } from "@/lib/resolve";

export const dynamic = "force-dynamic";

const Q = z.object({ text: z.string().trim().min(1).max(120), kind: z.enum(LOVE_KINDS) });

/** GET /api/resolve?text=Phoebe%20Bridgers&kind=artist → top 3 Qloo candidates for the clinician to confirm. */
export async function GET(req: Request) {
  try {
    const u = new URL(req.url);
    const q = Q.parse({ text: u.searchParams.get("text"), kind: u.searchParams.get("kind") });
    return json({ candidates: await resolveLove(qlooFromEnv(), q.text, q.kind) });
  } catch (e) {
    return errorResponse(e);
  }
}
