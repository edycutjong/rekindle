import { z } from "zod";
import { errorResponse, json } from "@/lib/http";
import { guard } from "@/lib/ratelimit";
import { qlooFromEnv } from "@/lib/qloo";
import { LOVE_KINDS, resolveLove, screenLoveText } from "@/lib/resolve";

export const dynamic = "force-dynamic";

// health details or personal data never reach Qloo: refused here, before any request (decision condition 1)
const Q = z.object({
  text: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .superRefine((t, ctx) => {
      const why = screenLoveText(t);
      if (why) ctx.addIssue({ code: "custom", message: why });
    }),
  kind: z.enum(LOVE_KINDS),
});

/** GET /api/resolve?text=Phoebe%20Bridgers&kind=artist → top 3 Qloo candidates for the clinician to confirm. */
export async function GET(req: Request) {
  const g = await guard(req, "resolve");
  if (g.deny) return g.deny;
  try {
    const u = new URL(req.url);
    const q = Q.parse({ text: u.searchParams.get("text"), kind: u.searchParams.get("kind") });
    return json({ candidates: await resolveLove(qlooFromEnv(), q.text, q.kind) });
  } catch (e) {
    return errorResponse(e);
  }
}
