/**
 * Qloo spike (build-plan D1). Asserts result DIFFERENCES, not HTTP 200s.
 *
 * For every parameter the product relies on, the spike sends a baseline request and the same request with the
 * parameter changed, then checks (a) that the result set/order/scores changed and (b) a semantic assertion where
 * one exists (e.g. every result carries the required tag, every distance is inside the radius). A control pair of
 * identical requests checks that the API is deterministic, so a "changed" verdict is not noise.
 *
 * Any parameter whose verdict is "no change" must be struck from the specs (build-plan D1 exit gate).
 *
 *   QLOO_API_KEY=… npx tsx scripts/spike.ts [--out spike/qloo-spike.json] [--capture fixtures/qloo_captured]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { qlooFromEnv, type InsightsResponse, type QlooCallLog, type QlooEntity, type QlooParams } from "../lib/qloo";
import { ALCOHOL_EXCLUDE_14, ALCOHOL_EXCLUDE_4, TAG_QUIET, TAG_WHEELCHAIR } from "../lib/tags";
import { tagIds, slotStatus, alcoholScreen } from "../lib/verify";

const args = process.argv.slice(2);
const argOf = (k: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
const OUT = argOf("--out");
const CAPTURE = argOf("--capture");
const today = new Date().toISOString().slice(0, 10);

const BRIDGERS = "AFBC71A7-9439-4AB0-AB68-D14B11AAF836";
const FLEABAG = "878680F2-2C8D-4D7A-8288-BEA75D38A843";
const RAMEN = "urn:tag:genre:place:restaurant:ramen";
const WILLIAMSBURG = "POINT(-73.9571 40.7081)";
const PARK_SLOPE = "POINT(-73.9799 40.6710)";
const BOZEMAN = "POINT(-111.0429 45.6770)";

const calls: QlooCallLog[] = [];
const q = qlooFromEnv((l) => calls.push(l));

type Row = { id: string; param: string; endpoint: string; changed: boolean; assertion: string; ok: boolean; detail: string };
const rows: Row[] = [];
const captured: Record<string, unknown> = {};

const ents = (r: InsightsResponse | { results: QlooEntity[] }) =>
  (Array.isArray((r as any).results) ? (r as any).results : ((r as InsightsResponse).results.entities ?? [])) as QlooEntity[];
const idList = (r: any) => ents(r).map((e) => e.entity_id);
const sig = (r: any) => ents(r).map((e) => `${e.entity_id}:${(e.query?.affinity ?? 0).toFixed(6)}`).join("|");
const differs = (a: any, b: any) => sig(a) !== sig(b);
const setDiff = (a: any, b: any) => {
  const A = new Set(idList(a));
  const B = new Set(idList(b));
  return { onlyA: [...A].filter((x) => !B.has(x)).length, onlyB: [...B].filter((x) => !A.has(x)).length };
};
const names = (r: any, n = 3) => ents(r).slice(0, n).map((e) => e.name).join(", ");

function record(row: Row) {
  rows.push(row);
  const mark = row.changed && row.ok ? "CHANGED+OK" : row.changed ? "CHANGED (assert FAIL)" : "NO CHANGE";
  console.log(`${row.id.padEnd(4)} ${mark.padEnd(22)} ${row.param.padEnd(44)} ${row.detail}`);
}

const placeBase: QlooParams = {
  "filter.type": "urn:entity:place",
  "signal.interests.entities": [BRIDGERS, FLEABAG],
  "filter.location": WILLIAMSBURG,
  "filter.location.radius": 1500,
  "feature.explainability": true,
  take: 25,
};
const mayaQuery: QlooParams = {
  ...placeBase,
  "signal.interests.tags": [RAMEN],
  "filter.hours": "thursday",
  "filter.price_level.max": 2,
};

/** Keep only the fields the product reads, so fixtures stay small and carry nothing beyond Qloo's public data. */
function trim(e: QlooEntity): QlooEntity {
  const p = e.properties ?? {};
  return {
    entity_id: e.entity_id,
    name: e.name,
    ...(e.type ? { type: e.type } : {}),
    ...(e.subtype ? { subtype: e.subtype } : {}),
    ...(e.types ? { types: e.types } : {}),
    properties: {
      ...(p.hours !== undefined ? { hours: p.hours } : {}),
      ...(p.address !== undefined ? { address: p.address } : {}),
      ...(p.price_level !== undefined ? { price_level: p.price_level } : {}),
      ...(p.is_closed !== undefined ? { is_closed: p.is_closed } : {}),
    },
    ...(e.location ? { location: e.location } : {}),
    tags: (e.tags ?? []).map((t) => ({ id: t.id ?? t.tag_id, name: t.name, type: t.type })),
    ...(e.query ? { query: { affinity: e.query.affinity, distance: e.query.distance, explainability: e.query.explainability } } : {}),
  } as QlooEntity;
}
function capture(name: string, body: any) {
  if (!CAPTURE) return;
  const out = Array.isArray(body?.results)
    ? { results: body.results.map(trim) }
    : body?.results?.entities
      ? { results: { entities: body.results.entities.map(trim) } }
      : body;
  captured[name] = out;
}

async function main() {
  console.log(`Qloo spike ${new Date().toISOString()} — base ${process.env.QLOO_BASE_URL ?? "(default hackathon host)"}\n`);

  // ---------- C0: determinism control ----------
  const c1 = await q.insights(mayaQuery);
  const c2 = await q.insights(mayaQuery);
  const deterministic = !differs(c1, c2);
  console.log(`C0   determinism control: identical requests → ${deterministic ? "IDENTICAL (diffs below are real)" : "DIFFERENT (API is non-deterministic; diffs below need care)"}\n`);
  capture(`${today}-maya-thu-recovery-off`, c1);

  // ---------- /search ----------
  {
    const a = await q.search("Phoebe Bridgers", { take: 5 });
    const b = await q.search("Phoebe Bridgers", { types: ["urn:entity:artist"], take: 5 });
    const allArtist = ents(b).every((e) => (e.types ?? []).includes("urn:entity:artist"));
    const unpinnedTypes = [...new Set(ents(a).flatMap((e) => e.types ?? []))];
    record({ id: "S1", param: "/search types (pin)", endpoint: "/search", changed: differs(a, b) || JSON.stringify(idList(a)) !== JSON.stringify(idList(b)), assertion: "pinned results are all urn:entity:artist", ok: allArtist && ents(b)[0]?.entity_id === BRIDGERS, detail: `unpinned types ${unpinnedTypes.join(",")} → pinned top ${names(b, 1)}` });
  }
  {
    const a = await q.search("Dun-Well Doughnuts", { types: ["urn:entity:place"], take: 20 });
    const b = await q.search("Dun-Well Doughnuts", { types: ["urn:entity:place"], take: 20, extra: { "filter.location": "40.7081,-73.9571", "filter.radius": 1 } });
    capture(`${today}-search-dunwell-near-maya`, b);
    const hits = ents(b);
    const withHours = hits.filter((e) => e.properties?.hours && Object.keys(e.properties.hours).length > 0).length;
    const withTags = hits.filter((e) => (e.tags ?? []).length > 0).length;
    const thuNull = hits.filter((e) => slotStatus(e.properties?.hours, "thursday", 12, 0).status === "UNKNOWN").length;
    const far = hits.filter((e) => e.location && haversine(40.7081, -73.9571, e.location.lat, e.location.lon) > 1609.4 * 1.05).length;
    record({ id: "P23", param: "/search filter.location + filter.radius", endpoint: "/search", changed: differs(a, b) || JSON.stringify(idList(a)) !== JSON.stringify(idList(b)), assertion: "all hits ≤1 mile; every hit carries tags; hours present or classed unknown", ok: far === 0 && withTags === hits.length, detail: `${hits.length} hits, ${far} beyond 1 mi, hours object on ${withHours}/${hits.length}, tags on ${withTags}/${hits.length}, Thu hours unknown on ${thuNull}; top ${names(b, 1)}` });
    // Does GET /entities fill in hours that /search omitted? (decides whether verify-venue needs the second call)
    const noHours = hits.filter((e) => !e.properties?.hours || Object.keys(e.properties.hours).length === 0).map((e) => e.entity_id);
    if (noHours.length) {
      const full = await q.entities(noHours);
      const filled = ents(full).filter((e) => e.properties?.hours && Object.keys(e.properties.hours).length > 0).length;
      record({ id: "E1", param: "GET /entities (hours for /search hits without hours)", endpoint: "/entities", changed: filled > 0, assertion: "the full entity carries hours that /search omitted", ok: filled > 0, detail: `${filled}/${noHours.length} hour-less /search hits gain hours via /entities` });
    }
  }

  // ---------- /v2/tags ----------
  {
    const a = await q.tags("ramen", { take: 10 });
    const b = await q.tags("pottery", { take: 10 });
    const ra = a.results.tags.map((t) => t.id);
    const rb = b.results.tags.map((t) => t.id);
    record({ id: "T1", param: "/v2/tags filter.query", endpoint: "/v2/tags", changed: JSON.stringify(ra) !== JSON.stringify(rb), assertion: `"ramen" resolves to ${RAMEN}`, ok: ra.includes(RAMEN), detail: `ramen → ${ra.slice(0, 3).join(", ")}; pottery → ${rb.slice(0, 2).join(", ")}` });
  }

  // ---------- /v2/insights place params ----------
  const base = await q.insights(placeBase);

  // signal.interests.entities
  {
    const b = await q.insights({ ...placeBase, "signal.interests.entities": [BRIDGERS] });
    const expl = ents(base).every((e) => Array.isArray((e.query?.explainability as any)?.["signal.interests.entities"]));
    record({ id: "I1", param: "signal.interests.entities", endpoint: "/v2/insights", changed: differs(base, b), assertion: "explainability lists the input entities on every result", ok: expl, detail: `Bridgers+Fleabag top ${names(base, 2)} vs Bridgers-only top ${names(b, 2)}` });
  }
  // feature.explainability
  {
    const b = await q.insights({ ...placeBase, "feature.explainability": false });
    const hasA = ents(base).filter((e) => e.query?.explainability).length;
    const hasB = ents(b).filter((e) => e.query?.explainability).length;
    record({ id: "I2", param: "feature.explainability", endpoint: "/v2/insights", changed: hasA !== hasB, assertion: "true → per-result explainability; false → none", ok: hasA === ents(base).length && hasB === 0, detail: `explainability on ${hasA}/${ents(base).length} (true) vs ${hasB}/${ents(b).length} (false)` });
  }
  // signal.interests.tags (P14)
  {
    const b = await q.insights({ ...placeBase, "signal.interests.tags": [RAMEN] });
    const ramenTop = ents(b).slice(0, 10).filter((e) => tagIds(e).some((t) => t.includes("ramen") || t.includes("japanese"))).length;
    const ramenTopBase = ents(base).slice(0, 10).filter((e) => tagIds(e).some((t) => t.includes("ramen") || t.includes("japanese"))).length;
    record({ id: "I3", param: "signal.interests.tags", endpoint: "/v2/insights", changed: differs(base, b), assertion: "ramen tag raises Japanese/ramen places in top 10", ok: ramenTop > ramenTopBase, detail: `Japanese/ramen in top 10: ${ramenTopBase} → ${ramenTop}` });
  }
  // filter.location (POINT)
  {
    const b = await q.insights({ ...placeBase, "filter.location": PARK_SLOPE });
    const { onlyA, onlyB } = setDiff(base, b);
    record({ id: "I4", param: "filter.location (WKT POINT)", endpoint: "/v2/insights", changed: differs(base, b), assertion: "different neighbourhood → mostly different places", ok: onlyA > ents(base).length / 2, detail: `Williamsburg vs Park Slope: ${onlyA} only-W, ${onlyB} only-PS` });
  }
  // filter.location.radius
  {
    const b = await q.insights({ ...placeBase, "filter.location.radius": 500 });
    const maxD = Math.max(...ents(b).map((e) => e.query?.distance ?? Infinity));
    record({ id: "I5", param: "filter.location.radius", endpoint: "/v2/insights", changed: differs(base, b), assertion: "every query.distance ≤ 500 m", ok: maxD <= 500, detail: `r=1500 max ${Math.round(Math.max(...ents(base).map((e) => e.query?.distance ?? 0)))} m → r=500 max ${Math.round(maxD)} m` });
  }
  // filter.hours
  {
    const b = await q.insights({ ...placeBase, "filter.hours": "sunday" });
    const closedSun = ents(b).filter((e) => slotStatus(e.properties?.hours, "sunday", 12, 0).dayClosed).length;
    const closedSunBase = ents(base).filter((e) => slotStatus(e.properties?.hours, "sunday", 12, 0).dayClosed).length;
    record({ id: "I6", param: "filter.hours", endpoint: "/v2/insights", changed: differs(base, b), assertion: "no result is closed:true on the filtered day", ok: closedSun === 0, detail: `closed on Sunday: ${closedSunBase} without filter → ${closedSun} with filter.hours=sunday` });
  }
  // filter.price_level.max
  {
    const b = await q.insights({ ...placeBase, "filter.price_level.max": 1 });
    const over = ents(b).filter((e) => (e.properties?.price_level ?? 0) > 1).length;
    const overBase = ents(base).filter((e) => (e.properties?.price_level ?? 0) > 1).length;
    record({ id: "I7", param: "filter.price_level.max", endpoint: "/v2/insights", changed: differs(base, b), assertion: "no result has price_level > 1", ok: over === 0, detail: `price_level>1: ${overBase} → ${over}` });
  }
  // filter.price_level.min
  {
    const b = await q.insights({ ...placeBase, "filter.price_level.min": 3 });
    const under = ents(b).filter((e) => (e.properties?.price_level ?? 0) < 3).length;
    record({ id: "I8", param: "filter.price_level.min", endpoint: "/v2/insights", changed: differs(base, b), assertion: "no result has price_level < 3", ok: under === 0 && ents(b).length > 0, detail: `${ents(b).length} results, ${under} below 3 (not used by the product; probed for completeness)` });
  }
  // filter.tags (quiet)
  {
    const b = await q.insights({ ...placeBase, "filter.tags": [TAG_QUIET] });
    const missing = ents(b).filter((e) => !tagIds(e).includes(TAG_QUIET)).length;
    record({ id: "I9", param: "filter.tags (quiet)", endpoint: "/v2/insights", changed: differs(base, b), assertion: "every result carries noise_level:qloo:quiet", ok: missing === 0 && ents(b).length > 0, detail: `${ents(b).length} results, ${missing} without the quiet tag; top ${names(b, 1)}` });
  }
  // operator.filter.tags=intersection
  {
    const u = await q.insights({ ...placeBase, "filter.tags": [TAG_QUIET, TAG_WHEELCHAIR], "operator.filter.tags": "union" });
    const i = await q.insights({ ...placeBase, "filter.tags": [TAG_QUIET, TAG_WHEELCHAIR], "operator.filter.tags": "intersection" });
    const both = ents(i).filter((e) => tagIds(e).includes(TAG_QUIET) && tagIds(e).includes(TAG_WHEELCHAIR)).length;
    record({ id: "I10", param: "operator.filter.tags=intersection", endpoint: "/v2/insights", changed: differs(u, i), assertion: "intersection → every result has both tags", ok: both === ents(i).length && ents(i).length > 0, detail: `union ${ents(u).length} results vs intersection ${ents(i).length} (${both} with both)` });
  }
  // filter.exclude.tags (14) on the Maya query, plus the 4-tag set
  const t14 = await q.insights({ ...mayaQuery, "filter.exclude.tags": [...ALCOHOL_EXCLUDE_14] });
  const t4 = await q.insights({ ...mayaQuery, "filter.exclude.tags": [...ALCOHOL_EXCLUDE_4] });
  capture(`${today}-maya-thu-recovery-on-14tags`, t14);
  capture(`${today}-maya-thu-exclude-4tags`, t4);
  {
    const carry = (r: any, set: readonly string[]) => ents(r).filter((e) => tagIds(e).some((t) => set.includes(t))).length;
    const alc = (r: any) => ents(r).filter((e) => alcoholScreen(e).verdict !== "PASS").length;
    record({ id: "I11", param: "filter.exclude.tags (14 alcohol tags)", endpoint: "/v2/insights", changed: differs(c1, t14), assertion: "no result carries any of the 14 excluded tags", ok: carry(t14, ALCOHOL_EXCLUDE_14) === 0, detail: `results carrying an excluded tag: ${carry(c1, ALCOHOL_EXCLUDE_14)}/25 → ${carry(t14, ALCOHOL_EXCLUDE_14)}; screen still flags ${alc(t14)} (4-tag set: screen flags ${alc(t4)}; recovery OFF: ${alc(c1)})` });
  }
  // filter.exclude.entities (P22)
  {
    const top = ents(base)[0];
    const b = await q.insights({ ...placeBase, "filter.exclude.entities": [top.entity_id] });
    const gone = !idList(b).includes(top.entity_id);
    record({ id: "P22", param: "filter.exclude.entities", endpoint: "/v2/insights", changed: differs(base, b), assertion: "the excluded entity is absent", ok: gone, detail: `excluded ${top.name} → absent=${gone}` });
  }
  // signal.interests.entities.weight
  {
    const lo = await q.insights({ ...mayaQuery, "signal.interests.entities.weight": 1 });
    const hi = await q.insights({ ...mayaQuery, "signal.interests.entities.weight": 50 });
    const { onlyA } = setDiff(lo, hi);
    record({ id: "W1", param: "signal.interests.entities.weight", endpoint: "/v2/insights", changed: differs(lo, hi), assertion: "weight 1 vs 50 reorders or rescores results", ok: differs(lo, hi), detail: `${onlyA} set changes; top lo ${names(lo, 2)} | top hi ${names(hi, 2)}` });
  }
  // signal.interests.tags.weight
  {
    const lo = await q.insights({ ...mayaQuery, "signal.interests.tags.weight": 1 });
    const hi = await q.insights({ ...mayaQuery, "signal.interests.tags.weight": 50 });
    const ramen = (r: any) => ents(r).slice(0, 10).filter((e) => tagIds(e).some((t) => t.includes("ramen") || t.includes("japanese"))).length;
    record({ id: "W2", param: "signal.interests.tags.weight", endpoint: "/v2/insights", changed: differs(lo, hi), assertion: "higher tag weight → more ramen/Japanese in top 10", ok: ramen(hi) >= ramen(lo) && differs(lo, hi), detail: `Japanese/ramen in top 10: weight 1 → ${ramen(lo)}, weight 50 → ${ramen(hi)}` });
  }
  // bias.trends
  {
    const off = await q.insights({ ...placeBase, "bias.trends": "off" });
    const high = await q.insights({ ...placeBase, "bias.trends": "high" });
    record({ id: "X1", param: "bias.trends", endpoint: "/v2/insights", changed: differs(off, high), assertion: "off vs high changes results", ok: differs(off, high), detail: `top off ${names(off, 2)} | top high ${names(high, 2)}` });
  }
  // filter.external.exists
  {
    const b = await q.insights({ ...placeBase, "filter.external.exists": "resy" });
    const withResy = ents(b).filter((e) => (e as any).external?.resy).length;
    record({ id: "X2", param: "filter.external.exists", endpoint: "/v2/insights", changed: differs(base, b), assertion: "every result has external.resy", ok: withResy === ents(b).length && ents(b).length > 0, detail: `${ents(b).length} results, ${withResy} with external.resy (not used by the product)` });
  }
  // diversify.by
  {
    const wide = { ...placeBase, "filter.location.radius": 40000 };
    const a = await q.insights(wide);
    const b = await q.insights({ ...wide, "diversify.by": "properties.geocode.city", "diversify.take": 2 });
    const cities = (r: any) => new Set(ents(r).map((e) => (e.properties as any)?.geocode?.city)).size;
    record({ id: "X3", param: "diversify.by (+diversify.take)", endpoint: "/v2/insights", changed: differs(a, b), assertion: "more distinct cities when diversified", ok: cities(b) > cities(a), detail: `distinct cities r=40 km: ${cities(a)} → ${cities(b)} (not used by the product)` });
  }

  // ---------- heatmap (P20, P13) + geohash handoff (P21) ----------
  let topCell = "";
  {
    const hm = (await q.insights({ "filter.type": "urn:heatmap", "signal.interests.entities": [BRIDGERS, FLEABAG], "filter.location": WILLIAMSBURG, "filter.location.radius": 1500, "output.heatmap.boundary": "urn:geohash" })) as any;
    const cells = hm.results.heatmap ?? [];
    const sorted = [...cells].sort((x: any, y: any) => y.query.affinity - x.query.affinity);
    topCell = sorted[0]?.location?.geohash ?? "";
    const hm2 = (await q.insights({ "filter.type": "urn:heatmap", "signal.interests.entities": [BRIDGERS], "filter.location": PARK_SLOPE, "filter.location.radius": 1500, "output.heatmap.boundary": "urn:geohash" })) as any;
    const top2 = [...(hm2.results.heatmap ?? [])].sort((x: any, y: any) => y.query.affinity - x.query.affinity)[0]?.location?.geohash;
    const near = cells.every((c: any) => haversine(40.7081, -73.9571, c.location.latitude, c.location.longitude) <= 1500 + 400);
    captured[`${today}-maya-heatmap`] = { results: { heatmap: sorted.slice(0, 60) } };
    record({ id: "P20", param: "filter.type=urn:heatmap + POINT + radius + boundary=urn:geohash", endpoint: "/v2/insights", changed: topCell !== top2, assertion: "cells are geohash-7 inside the radius (+1 cell slack)", ok: near && topCell.length === 7, detail: `${cells.length} cells, top ${topCell} (Park Slope/Bridgers-only top ${top2})` });
  }
  {
    let status = 200;
    try {
      await q.insights({ "filter.type": "urn:heatmap", "signal.interests.entities": [BRIDGERS, FLEABAG], "filter.location": WILLIAMSBURG, "filter.location.radius": 1500, "output.heatmap.boundary": "urn:entity:locality" });
    } catch (e: any) {
      status = e.status ?? 0;
    }
    // DX re-check, not a product param: "ok" means the known failure reproduces (it goes to DX-REPORT.md)
    record({ id: "P13", param: "DX re-check: output.heatmap.boundary=urn:entity:locality", endpoint: "/v2/insights", changed: true, assertion: "documented value still returns HTTP 500 (DX finding)", ok: status === 500, detail: `HTTP ${status} — re-check of the 500 seen 2026-10-07 (product uses urn:geohash only)` });
  }
  {
    const b = await q.insights({ ...placeBase, "filter.location": undefined, "filter.location.radius": undefined, "filter.location.geohash": topCell, take: 10 });
    const inside = ents(b).filter((e) => (e.location?.geohash ?? "").startsWith(topCell)).length;
    record({ id: "P21", param: "filter.location.geohash", endpoint: "/v2/insights", changed: differs(base, b), assertion: "every result's geohash starts with the cell", ok: inside === ents(b).length && ents(b).length > 0, detail: `${ents(b).length} results in ${topCell}, ${inside} inside (thin → POINT fallback stays)` });
  }

  // ---------- at-home types (P25) ----------
  for (const t of ["artist", "podcast", "book", "tv_show"]) {
    const r = await q.insights({ "filter.type": `urn:entity:${t}`, "signal.interests.entities": [BRIDGERS, FLEABAG], "feature.explainability": true, take: 5 });
    capture(`${today}-athome-${t}`, r);
    const expl = ents(r).filter((e) => Array.isArray((e.query?.explainability as any)?.["signal.interests.entities"])).length;
    // /v2/insights reports type "urn:entity" and the concrete type in `subtype`
    const wrongType = ents(r).filter((e) => (e.subtype ?? e.types?.[0]) !== `urn:entity:${t}`).length;
    record({ id: `H-${t.slice(0, 2)}`, param: `filter.type=urn:entity:${t}`, endpoint: "/v2/insights", changed: differs(base, r), assertion: "≥3 results of that type, explainability on all", ok: ents(r).length >= 3 && expl === ents(r).length && wrongType === 0, detail: `top ${names(r, 2)}; explainability ${expl}/${ents(r).length}` });
  }

  // ---------- P24: Bozeman + quiet coverage ----------
  {
    const boz = { ...mayaQuery, "signal.interests.tags": undefined, "filter.location": BOZEMAN };
    const a = await q.insights(boz);
    const b = await q.insights({ ...boz, "filter.tags": [TAG_QUIET] });
    record({ id: "P24", param: "Bozeman + filter.tags=quiet (coverage)", endpoint: "/v2/insights", changed: differs(a, b), assertion: "quiet in Bozeman returns < 4 places (coverage refusal fires)", ok: ents(b).length < 4, detail: `without quiet ${ents(a).length} → with quiet ${ents(b).length}` });
  }

  // ---------- Maya open-at-18:00 picture (seed-data claims to refresh) ----------
  {
    const e14 = ents(t14);
    const open18 = e14.filter((e) => slotStatus(e.properties?.hours, "thursday", 18, 0).status === "OPEN").length;
    const unk = e14.filter((e) => slotStatus(e.properties?.hours, "thursday", 18, 0).status === "UNKNOWN").length;
    console.log(`\nMaya (14-tag) Thu 18:00: ${open18}/${e14.length} open, ${unk} unknown hours; top ${e14[0]?.name} ${e14[0]?.query?.affinity?.toFixed(3)} ${Math.round(e14[0]?.query?.distance ?? 0)} m`);
  }

  // ---------- summary ----------
  const productParams = rows.filter((r) => !/not used by the product|re-check/.test(r.detail) && !r.param.startsWith("DX"));
  const changedOk = rows.filter((r) => r.changed && r.ok);
  const noChange = rows.filter((r) => !r.changed);
  const assertFail = rows.filter((r) => r.changed && !r.ok);
  console.log(`\nSUMMARY: ${rows.length} probes · ${changedOk.length} changed results AND passed their assertion · ${assertFail.length} changed but failed the assertion · ${noChange.length} no change`);
  console.log(`         distinct product params that changed results: ${new Set(productParams.filter((r) => r.changed && r.ok).map((r) => r.param)).size}`);
  if (noChange.length) console.log(`STRIKE FROM SPECS (no change): ${noChange.map((r) => r.param).join("; ")}`);
  if (assertFail.length) console.log(`ASSERTION FAILURES: ${assertFail.map((r) => r.param).join("; ")}`);
  console.log(`Qloo calls: ${calls.length}, p50 ${pct(calls.map((c) => c.ms), 50)} ms, p95 ${pct(calls.map((c) => c.ms), 95)} ms, non-200: ${calls.filter((c) => c.status !== 200).length}`);
  const fallbackTrigger = rows.filter((r) => ["I6", "I9", "I10", "I11", "I5"].includes(r.id) && !(r.changed && r.ok));
  console.log(fallbackTrigger.length ? `FALLBACK TRIGGER: hours/filters unusable → ${fallbackTrigger.map((r) => r.param).join("; ")}` : "FALLBACK TRIGGER: not hit (hours + filters usable)");

  if (OUT) writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), deterministic, rows, calls: calls.map(({ at, ...c }) => c) }, null, 2) + "\n");
  if (CAPTURE) {
    mkdirSync(CAPTURE, { recursive: true });
    for (const [name, body] of Object.entries(captured)) writeFileSync(join(CAPTURE, `${name}.json`), JSON.stringify(body) + "\n");
    console.log(`captured ${Object.keys(captured).length} trimmed fixtures → ${CAPTURE}`);
  }
}

function haversine(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function pct(xs: number[], p: number) {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] : NaN;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
