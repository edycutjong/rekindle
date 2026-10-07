/**
 * DX-REPORT.md reproductions. Every number in DX-REPORT.md comes from this script's output (spike/dx-repro.json).
 * Plain HTTP GETs against the hackathon host (no client retry, so a 500 shows as a 500), then the product's own
 * verifier helpers (lib/verify.ts) classify what came back.
 *
 *   QLOO_API_KEY=… npx tsx scripts/dx-repro.ts [--out spike/dx-repro.json]
 */
import { writeFileSync } from "node:fs";
import type { QlooEntity } from "../lib/qloo";
import { ALCOHOL_EXCLUDE_14, ALCOHOL_EXCLUDE_4 } from "../lib/tags";
import { alcoholScreen, slotStatus } from "../lib/verify";

const KEY = process.env.QLOO_API_KEY;
if (!KEY) throw new Error("QLOO_API_KEY is not set");
const BASE = process.env.QLOO_BASE_URL ?? "https://hackathon.api.qloo.com";
const OUT = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : undefined;

const BRIDGERS = "AFBC71A7-9439-4AB0-AB68-D14B11AAF836";
const FLEABAG = "878680F2-2C8D-4D7A-8288-BEA75D38A843";
const RAMEN = "urn:tag:genre:place:restaurant:ramen";
const WILLIAMSBURG = "POINT(-73.9571 40.7081)";

async function get(path: string, params: Record<string, string | number>) {
  const u = new URL(path, BASE);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  const t = Date.now();
  const r = await fetch(u, { headers: { "X-Api-Key": KEY! } });
  const text = await r.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text.slice(0, 300);
  }
  return { status: r.status, ms: Date.now() - t, body: body as Record<string, unknown>, query: u.search.replaceAll("%2C", ",").replaceAll("%3A", ":") };
}

const ents = (b: Record<string, unknown>): QlooEntity[] => {
  const r = b?.results as unknown;
  if (Array.isArray(r)) return r as QlooEntity[];
  return ((r as { entities?: QlooEntity[] })?.entities ?? []) as QlooEntity[];
};

const maya = {
  "filter.type": "urn:entity:place",
  "signal.interests.entities": `${BRIDGERS},${FLEABAG}`,
  "signal.interests.tags": RAMEN,
  "filter.location": WILLIAMSBURG,
  "filter.location.radius": 1500,
  "filter.hours": "thursday",
  "filter.price_level.max": 2,
  "feature.explainability": "true",
  take: 25,
};

async function main() {
  const out: Record<string, unknown> = { generated_by: "scripts/dx-repro.ts", at: new Date().toISOString(), base: BASE };

  // F1: heatmap boundary urn:entity:locality → 500 (the error message for a bad value names it as valid)
  const heat = { "filter.type": "urn:heatmap", "filter.location.query": "Brooklyn", "signal.interests.entities": `${BRIDGERS},${FLEABAG}` };
  const loc = await get("/v2/insights", { ...heat, "output.heatmap.boundary": "urn:entity:locality" });
  const bad = await get("/v2/insights", { ...heat, "output.heatmap.boundary": "neighborhood" });
  const geo = await get("/v2/insights", { ...heat, "output.heatmap.boundary": "urn:geohash" });
  out.F1_heatmap_locality = { locality: { status: loc.status, body: loc.body }, invalid_value: { status: bad.status, body: bad.body }, geohash_status: geo.status };

  // F2: filter.exclude.tags leaks — alcohol-screened places that survive the server-side exclusion
  const leak = async (label: string, tags: readonly string[] | null) => {
    const r = await get("/v2/insights", tags ? { ...maya, "filter.exclude.tags": tags.join(",") } : maya);
    const list = ents(r.body);
    const refused = list.filter((e) => alcoholScreen(e).verdict === "REFUSE");
    const review = list.filter((e) => alcoholScreen(e).verdict === "REVIEW");
    return { label, status: r.status, results: list.length, alcohol_refused_by_screen: refused.length, review: review.length, examples: refused.slice(0, 4).map((e) => ({ name: e.name, hits: alcoholScreen(e).hits.slice(0, 3).map((h) => h.value) })) };
  };
  out.F2_exclude_tags_leak = [await leak("no exclusion", null), await leak("4 bar tags", ALCOHOL_EXCLUDE_4), await leak("14 alcohol tags", ALCOHOL_EXCLUDE_14)];

  // F3: hours — day-level filter only; null hours on returned places; /search hits without an hours object
  const { "signal.interests.tags": _tagSignal, ...noTag } = maya;
  void _tagSignal;
  const wide = await get("/v2/insights", { ...noTag, "filter.location.radius": 2500 });
  const wl = ents(wide.body);
  const unknown = wl.filter((e) => slotStatus(e.properties?.hours, "thursday", 18).status === "UNKNOWN");
  const closed18 = wl.filter((e) => slotStatus(e.properties?.hours, "thursday", 18).status === "CLOSED");
  const s = await get("/search", { query: "Dun-Well Doughnuts", types: "urn:entity:place", "filter.location": "40.7081,-73.9571", "filter.radius": 1 });
  const sl = ents(s.body);
  out.F3_hours = {
    insights_filter_hours_thursday: { results: wl.length, unknown_thursday_hours: unknown.length, closed_at_18: closed18.length, unknown_examples: unknown.slice(0, 3).map((e) => e.name) },
    search_hits: sl.length,
    search_hits_without_hours_object: sl.filter((e) => !e.properties?.hours).length,
  };

  // F4: /search name matching is fuzzy — the hits for one exact venue name
  out.F4_search_fuzzy = { query: "Dun-Well Doughnuts", hits: sl.length, names: sl.map((e) => e.name), exact_name_hits: sl.filter((e) => e.name === "Dun-Well Doughnuts").length };

  // F5: filter.location.query is a fuzzy locality — "Brooklyn" returns places whose address is not in Brooklyn
  const bk = await get("/v2/insights", { "filter.type": "urn:entity:place", "filter.location.query": "Brooklyn", "signal.interests.entities": `${BRIDGERS},${FLEABAG}`, take: 50 });
  const bl = ents(bk.body);
  const addr = (e: QlooEntity) => String((e.properties as { address?: string } | undefined)?.address ?? "");
  const notBk = bl.filter((e) => addr(e) && !/brooklyn/i.test(addr(e)));
  out.F5_location_query = { results: bl.length, with_address: bl.filter((e) => addr(e)).length, address_not_brooklyn: notBk.length, examples: notBk.slice(0, 4).map((e) => ({ name: e.name, address: addr(e) })) };

  // F6: response shape drift between endpoints (tags `id` vs `tag_id`; insights `type` vs `subtype`)
  const art = await get("/v2/insights", { "filter.type": "urn:entity:artist", "signal.interests.entities": `${BRIDGERS},${FLEABAG}`, take: 1 });
  const a0 = ents(art.body)[0] as unknown as Record<string, unknown> | undefined;
  const ins0 = (wl[0]?.tags?.[0] ?? {}) as Record<string, unknown>;
  const s0 = (sl[0]?.tags?.[0] ?? {}) as Record<string, unknown>;
  out.F6_shapes = { insights_tag_keys: Object.keys(ins0), search_tag_keys: Object.keys(s0), insights_artist_type: a0?.type ?? null, insights_artist_subtype: a0?.subtype ?? null };

  // F7: explainability names entity signals only — a tag signal never appears in the per-input split
  const ex = ents((await get("/v2/insights", maya)).body)[0] as unknown as { query?: { explainability?: Record<string, unknown> } } | undefined;
  out.F7_explainability = { keys: Object.keys(ex?.query?.explainability ?? {}), has_tag_input: JSON.stringify(ex?.query?.explainability ?? {}).includes(RAMEN) };

  const json = JSON.stringify(out, null, 1);
  if (OUT) writeFileSync(OUT, json + "\n");
  console.log(json);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
