import { z } from "zod";
import { errorResponse, json } from "@/lib/http";
import { qlooFromEnv } from "@/lib/qloo";
import { guard } from "@/lib/ratelimit";
import { DAYS } from "@/lib/verify";
import { nominatim, verifyVenue } from "@/lib/venue";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const Body = z
  .object({
    name: z.string().trim().min(1).max(160),
    address: z.string().trim().min(3).max(300).optional(),
    entity_id: z.string().trim().min(1).max(80).optional(),
    day: z.enum(DAYS),
    hour: z.number().int().min(0).max(23),
    origin: z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) }).optional(),
    point: z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) }).optional(),
  })
  .strict()
  .refine((b) => b.address || b.entity_id || b.point, "address, point or entity_id is required");

/**
 * POST /api/verify-venue — bench only (bench token; its own quota, never the public or judge caps). Grades one named
 * venue at one slot: Nominatim geocode of the stated address → Qloo `/search` within 1 mile → name match ≤ 300 m →
 * hours at the slot + R-ALC on that Qloo record. With `entity_id` it grades the Qloo record directly (`/entities`).
 * Used by scripts/bench.py for arm A (LLM-only plans) and to grade arm B with the same oracle.
 */
export async function POST(req: Request) {
  const g = await guard(req, "resolve");
  if (g.deny) return g.deny;
  if (g.ns !== "bench") return json({ error: "bench only" }, 403);
  try {
    const b = Body.parse(await req.json());
    const calls: { path: string; status: number; ms: number; n_results: number }[] = [];
    const qloo = qlooFromEnv((l) => calls.push({ path: l.path, status: l.status, ms: l.ms, n_results: l.n_results }));
    const verdict = await verifyVenue(qloo, nominatim(), b);
    return json({ verdict, calls }, 200, g.headers);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("Nominatim")) return json({ error: e.message }, 502);
    return errorResponse(e);
  }
}
