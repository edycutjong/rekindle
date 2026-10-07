import { z } from "zod";
import { errorResponse, json } from "@/lib/http";
import { guard } from "@/lib/ratelimit";
import { wkt } from "@/lib/plan";
import { storeFor } from "@/lib/scope";
import { CaseDoc, newId } from "@/lib/store";

export const dynamic = "force-dynamic";

const Intake = z.object({
  label: z.string().trim().min(1).max(40),
  locality: z.string().trim().max(80).default(""),
  lon: z.number().min(-180).max(180),
  lat: z.number().min(-90).max(90),
  energy: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  price_max: z.number().int().min(1).max(4).default(2),
  max_meters: z.number().int().min(300).max(10000).optional(),
  in_recovery: z.boolean().default(false),
  need_quiet: z.boolean().default(false),
  need_wheelchair: z.boolean().default(false),
  /** loves the clinician confirmed from /api/resolve */
  loves: z
    .array(z.object({ text: z.string().trim().min(1).max(120), qloo_id: z.string().min(1).max(200), qloo_kind: z.enum(["entity", "tag"]), entity_type: z.string().max(40).optional(), name: z.string().max(200).optional() }))
    .min(1)
    .max(6),
});

/** POST /api/cases — intake. Stores the case row; no plan is run until POST /api/cases/:id/plan. */
export async function POST(req: Request) {
  const g = await guard(req, "write");
  if (g.deny) return g.deny;
  try {
    const b = Intake.parse(await req.json());
    const doc = CaseDoc.parse({
      ...b,
      id: newId(),
      created_at: new Date().toISOString(),
      point_wkt: wkt(b.lon, b.lat),
      max_meters: b.max_meters ?? { 1: 1500, 2: 3000, 3: 5000 }[b.energy],
      is_seed: false,
      loves: b.loves.map((l) => ({ id: newId(), weight: 1, ...l })),
    });
    await storeFor(req).putCase(doc);
    return json({ case: doc }, 201);
  } catch (e) {
    return errorResponse(e);
  }
}
