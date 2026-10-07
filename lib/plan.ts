/**
 * Plan core — the deterministic half of the agent. Builds Qloo requests from the CASE row, runs every candidate through
 * the verifier, fills slots, re-slots R-OPEN misses, and re-verifies a week when a constraint changes.
 *
 * The LLM (D3) only chooses which of these tools to call and with which typed params; constraints never come from it:
 * radius is clamped to the case maximum (I6) and the quiet / wheelchair / recovery filters are applied from the case
 * flags on every request (I7).
 */
import type { QlooCallLog, QlooClient, QlooEntity, QlooParams } from "./qloo";
import { QlooError } from "./qloo";
import { ALCOHOL_EXCLUDE_14, TAG_QUIET, TAG_WHEELCHAIR } from "./tags";
import { DAYS, explainSplit, reslotHour, slotStatus, verifyCard, type CaseConstraints, type DayName, type RuleResult, type Verdict } from "./verify";

export type Rung = "home" | "solo" | "social";
export type HomeType = "artist" | "podcast" | "book" | "tv_show";
export const HOME_TYPES: readonly HomeType[] = ["artist", "podcast", "book", "tv_show"];

export interface Love {
  text: string;
  /** Qloo entity_id, or tag id for kind "tag" */
  qlooId: string;
  kind: "entity" | "tag";
  /** urn:entity:artist … (entities only) */
  entityType?: string;
  /** display name as Qloo returned it */
  name?: string;
}

export interface CaseRow extends CaseConstraints {
  label: string;
  /** WGS84 point; sent to Qloo as WKT POINT(lon lat) */
  lon: number;
  lat: number;
  energy: 1 | 2 | 3;
  loves: Love[];
}

export interface SlotSpec {
  day: DayName;
  hour: number;
  rung: Rung;
  homeType?: HomeType;
}

export interface WhyPart {
  entity_id: string;
  name: string;
  score: number;
}

export interface Card {
  slot: SlotSpec;
  /** the hour actually scheduled (differs from slot.hour after a re-slot) */
  hour: number;
  movedFrom?: number;
  rung: Rung;
  entity_id: string;
  name: string;
  entityType: string;
  affinity: number;
  distance_m?: number;
  priceLevel?: number;
  hoursText?: string;
  address?: string;
  tags: string[];
  why: WhyPart[];
  verdict: Verdict;
  checks: RuleResult[];
  /** set when the social card's cell came from the heatmap */
  geohash?: string;
}

export interface Refusal {
  day: DayName;
  hour: number;
  entity_id: string;
  name: string;
  rule: string;
  detail: string;
  verdict: Verdict;
  /** R-OPEN refusal whose entity was re-slotted to `movedTo` */
  movedTo?: number;
  /** struck from an existing week by a constraint toggle */
  struckByToggle?: boolean;
  /** struck by the clinician gate (swap / remove), not by a verifier rule */
  byClinician?: "swapped" | "removed";
}

export interface SlotOutcome {
  slot: SlotSpec;
  card: Card | null;
  /** why the slot is empty, when it is */
  empty?: string;
}

export interface WeekPlan {
  week: number;
  slots: SlotOutcome[];
  refusals: Refusal[];
  /** REVIEW candidates held for the clinician; never placed automatically */
  review: Card[];
  calls: QlooCallLog[];
}

export interface PlanHistory {
  /** entity IDs rated ≥ 7 that become signals (re-plan) */
  rekindled: { entity_id: string; name: string; tags: string[]; entityType: string }[];
  /** entity IDs rated ≤ 3 → filter.exclude.entities + R-HIST */
  lowRated: string[];
  /** distinctive tags of ≤ 3 cards → filter.exclude.tags */
  excludeTags: string[];
  /** extra tag signals from ≥ 7 places */
  signalTags: string[];
}

export const EMPTY_HISTORY: PlanHistory = { rekindled: [], lowRated: [], excludeTags: [], signalTags: [] };

/* ------------------------------------------------------------------ ladder */

/** Graded 7-day ladder by energy: at-home doses early, solo outings later, one social outing (spec Core Feature 2). */
export function ladder(energy: 1 | 2 | 3): SlotSpec[] {
  const H = (day: DayName, hour: number, homeType: HomeType): SlotSpec => ({ day, hour, rung: "home", homeType });
  const S = (day: DayName, hour: number): SlotSpec => ({ day, hour, rung: "solo" });
  const X = (day: DayName, hour: number): SlotSpec => ({ day, hour, rung: "social" });
  if (energy === 1) return [H("monday", 19, "artist"), H("tuesday", 19, "podcast"), H("wednesday", 19, "book"), S("thursday", 18), H("friday", 19, "tv_show"), S("saturday", 11), X("sunday", 14)];
  if (energy === 2) return [H("monday", 19, "artist"), H("tuesday", 19, "podcast"), S("wednesday", 17), S("thursday", 18), H("friday", 19, "tv_show"), S("saturday", 11), X("sunday", 14)];
  return [H("monday", 19, "artist"), S("tuesday", 17), H("wednesday", 19, "podcast"), S("thursday", 18), S("friday", 17), S("saturday", 11), X("sunday", 14)];
}

/** Hours an outing may be moved to on the same day (re-slot on R-OPEN). */
export const DAY_HOURS: readonly number[] = [10, 13, 15, 18];

/* ------------------------------------------------------------------ params (I6/I7) */

export const wkt = (lon: number, lat: number) => `POINT(${lon} ${lat})`;

export function signals(c: CaseRow, h: PlanHistory) {
  const entities = [...c.loves.filter((l) => l.kind === "entity").map((l) => l.qlooId), ...h.rekindled.map((r) => r.entity_id)];
  const tags = [...c.loves.filter((l) => l.kind === "tag").map((l) => l.qlooId), ...h.signalTags];
  return { entities: [...new Set(entities)], tags: [...new Set(tags)] };
}

export interface OutingParamsOpts {
  /** LLM-supplied; can only tighten (I6) */
  narrowMeters?: number;
  /** extra entity exclusions (already used this week) */
  excludeEntities?: string[];
  /** replace the case point with a geohash cell (social placement) */
  geohash?: string;
  /** replace the case point (social fallback at the cell centre) */
  center?: { lon: number; lat: number; radius: number };
  /** bench only: which alcohol tag set Qloo excludes server-side */
  excludeTagSet?: readonly string[];
}

/** Build the place query from the CASE row. Radius ≤ case max, price = case cap, constraint tags always applied. */
export function outingParams(c: CaseRow, day: DayName, h: PlanHistory, o: OutingParamsOpts = {}): QlooParams {
  const s = signals(c, h);
  const radius = Math.min(o.narrowMeters ?? c.maxMeters, c.maxMeters);
  const requireTags = [...(c.needQuiet ? [TAG_QUIET] : []), ...(c.needWheelchair ? [TAG_WHEELCHAIR] : [])];
  const excludeTags = [...(c.inRecovery ? (o.excludeTagSet ?? ALCOHOL_EXCLUDE_14) : []), ...h.excludeTags];
  const p: QlooParams = {
    "filter.type": "urn:entity:place",
    "signal.interests.entities": s.entities,
    "signal.interests.tags": s.tags,
    "filter.hours": day,
    "filter.price_level.max": c.priceMax,
    "filter.tags": requireTags,
    "operator.filter.tags": requireTags.length > 1 ? "intersection" : undefined,
    "filter.exclude.tags": [...new Set(excludeTags)],
    "filter.exclude.entities": [...new Set([...h.lowRated, ...(o.excludeEntities ?? [])])],
    "feature.explainability": true,
    take: 25,
  };
  if (o.geohash) p["filter.location.geohash"] = o.geohash;
  else if (o.center) {
    p["filter.location"] = wkt(o.center.lon, o.center.lat);
    p["filter.location.radius"] = Math.min(o.center.radius, c.maxMeters);
  } else {
    p["filter.location"] = wkt(c.lon, c.lat);
    p["filter.location.radius"] = radius;
  }
  return p;
}

export function homeParams(c: CaseRow, type: HomeType, take: number, h: PlanHistory, excludeEntities: string[] = []): QlooParams {
  const s = signals(c, h);
  return {
    "filter.type": `urn:entity:${type}`,
    "signal.interests.entities": s.entities,
    "signal.interests.tags": s.tags.filter((t) => !t.includes(":place")), // place tags do not apply to media
    "filter.exclude.entities": [...new Set([...h.lowRated, ...excludeEntities])],
    "feature.explainability": true,
    take: Math.max(3, Math.min(10, take)),
  };
}

/* ------------------------------------------------------------------ helpers */

export function haversine(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const a = Math.sin(toRad(lat2 - lat1) / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(toRad(lon2 - lon1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function loveNames(c: CaseRow, h: PlanHistory): Map<string, string> {
  const m = new Map<string, string>();
  for (const l of c.loves) m.set(l.qlooId, l.name ?? l.text);
  for (const r of h.rekindled) m.set(r.entity_id, r.name);
  return m;
}

function toCard(e: QlooEntity, slot: SlotSpec, hour: number, verdict: Verdict, checks: RuleResult[], names: Map<string, string>, distance?: number): Card {
  const tags = (e.tags ?? []).map((t) => t.id ?? t.tag_id ?? "").filter(Boolean);
  return {
    slot,
    hour,
    ...(hour !== slot.hour ? { movedFrom: slot.hour } : {}),
    rung: slot.rung,
    entity_id: e.entity_id,
    name: e.name,
    entityType: e.subtype ?? e.types?.[0] ?? e.type ?? "",
    affinity: e.query?.affinity ?? 0,
    ...(distance !== undefined ? { distance_m: Math.round(distance) } : {}),
    ...(typeof e.properties?.price_level === "number" ? { priceLevel: e.properties.price_level } : {}),
    ...(slot.rung !== "home" ? { hoursText: slotStatus(e.properties?.hours, slot.day, hour).hoursText } : {}),
    ...(typeof e.properties?.address === "string" ? { address: e.properties.address } : {}),
    tags,
    why: explainSplit(e).map((x) => ({ entity_id: x.entity_id, name: names.get(x.entity_id) ?? x.entity_id, score: x.score })),
    verdict,
    checks,
  };
}

export interface ToolContext {
  qloo: QlooClient;
  case: CaseRow;
  history: PlanHistory;
  /** entity IDs already on the sheet this week (never picked twice) */
  used: Set<string>;
  /** the place IDs among them, sent as filter.exclude.entities on place queries */
  usedPlaces?: Set<string>;
  /** IDs Qloo returned in this run (R-ID) */
  seen: Set<string>;
  /** bench ablation only */
  alcoholScreen?: boolean;
  excludeTagSet?: readonly string[];
}

export interface ToolResult {
  card: Card | null;
  refusals: Refusal[];
  review: Card[];
  empty?: string;
  /** results returned by Qloo for this tool call */
  returned: number;
}

/* ------------------------------------------------------------------ tools */

/** At-home dose: one entity of `type` (Qloo picks the entity; the coaching line sets the 10-minute dose). */
export async function findAtHome(ctx: ToolContext, slot: SlotSpec, type: HomeType, take = 5): Promise<ToolResult> {
  const names = loveNames(ctx.case, ctx.history);
  let res;
  try {
    res = await ctx.qloo.insights(homeParams(ctx.case, type, take, ctx.history, [...ctx.used]));
  } catch (e) {
    return { card: null, refusals: [], review: [], empty: qlooDown(e), returned: 0 };
  }
  const list = res.results.entities ?? [];
  list.forEach((e) => ctx.seen.add(e.entity_id));
  for (const e of list) {
    if (ctx.used.has(e.entity_id)) continue;
    const v = verifyCard(e, { kind: "home", constraints: ctx.case, lowRated: new Set(ctx.history.lowRated), seenIds: ctx.seen });
    if (v.verdict === "PASS") {
      ctx.used.add(e.entity_id);
      return { card: toCard(e, slot, slot.hour, "PASS", v.checks, names), refusals: [], review: [], returned: list.length };
    }
  }
  return { card: null, refusals: [], review: [], empty: `no verified ${type} for these loves`, returned: list.length };
}

/** Solo outing: verified place open at the slot, near, within budget, allowed. */
export async function findOutings(ctx: ToolContext, slot: SlotSpec, o: OutingParamsOpts & { originForDistance?: boolean } = {}): Promise<ToolResult> {
  const names = loveNames(ctx.case, ctx.history);
  let res;
  try {
    res = await ctx.qloo.insights(outingParams(ctx.case, slot.day, ctx.history, { ...o, excludeEntities: [...(ctx.usedPlaces ?? [])], excludeTagSet: ctx.excludeTagSet }));
  } catch (e) {
    return { card: null, refusals: [], review: [], empty: qlooDown(e), returned: 0 };
  }
  const list = res.results.entities ?? [];
  list.forEach((e) => ctx.seen.add(e.entity_id));
  const refusals: Refusal[] = [];
  const review: Card[] = [];
  const lowRated = new Set(ctx.history.lowRated);
  for (const e of list) {
    if (ctx.used.has(e.entity_id)) continue;
    // distance from the patient's point, not from a heatmap cell centre
    const distance = o.originForDistance && e.location ? haversine(ctx.case.lat, ctx.case.lon, e.location.lat, e.location.lon) : e.query?.distance;
    const ent: QlooEntity = distance !== undefined ? { ...e, query: { ...e.query, distance } } : e;
    const base = { kind: "outing" as const, constraints: ctx.case, lowRated, seenIds: ctx.seen, alcoholScreen: ctx.alcoholScreen };
    const v = verifyCard(ent, { ...base, slot: { day: slot.day, hour: slot.hour } });
    if (v.verdict === "PASS") {
      ctx.used.add(e.entity_id);
      ctx.usedPlaces?.add(e.entity_id);
      return { card: toCard(ent, slot, slot.hour, "PASS", v.checks, names, distance), refusals, review, returned: list.length };
    }
    if (v.verdict === "REVIEW") {
      review.push(toCard(ent, slot, slot.hour, "REVIEW", v.checks, names, distance));
      continue;
    }
    // re-slot: refused only by R-OPEN with known hours → latest open free hour that day
    const onlyOpen = v.reasons.length === 1 && v.reasons[0].rule === "R-OPEN" && slotStatus(e.properties?.hours, slot.day, slot.hour).status === "CLOSED" && e.properties?.is_closed !== true;
    const moved = onlyOpen ? reslotHour(e.properties?.hours, slot.day, DAY_HOURS.filter((x) => x !== slot.hour)) : null;
    for (const r of v.reasons) refusals.push({ day: slot.day, hour: slot.hour, entity_id: e.entity_id, name: e.name, rule: r.rule, detail: r.detail, verdict: r.verdict, ...(moved !== null ? { movedTo: moved } : {}) });
    if (moved !== null) {
      const v2 = verifyCard(ent, { ...base, slot: { day: slot.day, hour: moved } });
      if (v2.verdict === "PASS") {
        ctx.used.add(e.entity_id);
        ctx.usedPlaces?.add(e.entity_id);
        return { card: toCard(ent, slot, moved, "PASS", v2.checks, names, distance), refusals, review, returned: list.length };
      }
    }
  }
  return { card: null, refusals, review, empty: list.length ? `no candidate passed all rules (${list.length} checked)` : "Qloo returned no places for these filters", returned: list.length };
}

/** Social outing: heatmap → top-affinity geohash cell → places in that cell (POINT fallback at the cell centre). */
export async function placeSocial(ctx: ToolContext, slot: SlotSpec): Promise<ToolResult & { cell?: string; cells?: { geohash: string; affinity: number; lat: number; lon: number }[] }> {
  const s = signals(ctx.case, ctx.history);
  let hm;
  try {
    hm = await ctx.qloo.insights({
      "filter.type": "urn:heatmap",
      "signal.interests.entities": s.entities,
      "filter.location": wkt(ctx.case.lon, ctx.case.lat),
      "filter.location.radius": ctx.case.maxMeters,
      "output.heatmap.boundary": "urn:geohash",
    });
  } catch (e) {
    return { card: null, refusals: [], review: [], empty: qlooDown(e), returned: 0 };
  }
  const cells = (hm.results.heatmap ?? [])
    .map((c) => ({ geohash: c.location.geohash, affinity: c.query.affinity, lat: c.location.latitude, lon: c.location.longitude }))
    .filter((c) => haversine(ctx.case.lat, ctx.case.lon, c.lat, c.lon) <= ctx.case.maxMeters)
    .sort((a, b) => b.affinity - a.affinity);
  const top = cells[0];
  if (!top) return { card: null, refusals: [], review: [], empty: "no heatmap cell inside the radius", returned: 0 };
  // The geohash-7 cell is often thin (P21: 2 places). Fall back in affinity order: the top cell itself, POINT + 400 m
  // around the top three cells, then 800 m around the top cell. Distance is always measured from the patient's point
  // and R-NEAR still applies, so a fallback can never place the outing outside the case radius.
  const attempts: OutingParamsOpts[] = [
    { geohash: top.geohash },
    ...cells.slice(0, 3).map((c) => ({ center: { lon: c.lon, lat: c.lat, radius: 400 } })),
    { center: { lon: top.lon, lat: top.lat, radius: 800 } },
  ];
  const refusals: Refusal[] = [];
  const review: Card[] = [];
  let returned = 0;
  let last: ToolResult | null = null;
  for (const a of attempts) {
    const r = await findOutings(ctx, slot, { ...a, originForDistance: true });
    refusals.push(...r.refusals);
    review.push(...r.review);
    returned += r.returned;
    last = r;
    if (r.card) {
      const cell = a.geohash ?? cells.find((c) => c.lon === a.center?.lon && c.lat === a.center?.lat)?.geohash ?? top.geohash;
      return { card: { ...r.card, geohash: cell }, refusals, review, returned, cell, cells: cells.slice(0, 49) };
    }
    if (r.empty?.startsWith("Qloo unavailable")) break;
  }
  return { card: null, refusals, review, returned, empty: last?.empty ?? "no social venue passed all rules", cell: top.geohash, cells: cells.slice(0, 49) };
}

function qlooDown(e: unknown): string {
  if (e instanceof QlooError) return `Qloo unavailable (${e.status || "network"}) — slot left empty`;
  return "Qloo unavailable — slot left empty";
}

/* ------------------------------------------------------------------ week (deterministic routing) */

/**
 * Fill the ladder slot by slot. This is the deterministic route the D3 agent loop must at least match; the agent
 * may choose different home types / narrower radii, but it calls the same tools and cannot bypass the verifier.
 */
export async function planWeek(qloo: QlooClient, c: CaseRow, week: number, history: PlanHistory = EMPTY_HISTORY, opts: { alcoholScreen?: boolean; excludeTagSet?: readonly string[]; calls?: QlooCallLog[] } = {}): Promise<WeekPlan> {
  const ctx: ToolContext = { qloo, case: c, history, used: new Set(), usedPlaces: new Set(), seen: new Set(), alcoholScreen: opts.alcoholScreen, excludeTagSet: opts.excludeTagSet };
  const out: WeekPlan = { week, slots: [], refusals: [], review: [], calls: opts.calls ?? [] };
  for (const slot of ladder(c.energy)) {
    const r = slot.rung === "home" ? await findAtHome(ctx, slot, slot.homeType!) : slot.rung === "solo" ? await findOutings(ctx, slot) : await placeSocial(ctx, slot);
    out.slots.push({ slot, card: r.card, ...(r.card ? {} : { empty: r.empty }) });
    out.refusals.push(...r.refusals);
    out.review.push(...r.review);
  }
  return out;
}

/**
 * Re-run only the rules a constraint toggle can change (R-ALC, R-QUIET, R-ACCESS, R-NEAR, R-PRICE) on a placed card.
 * Hours and kind were verified when the card was placed and do not depend on the case flags.
 */
export function recheckConstraints(card: Card, c: CaseConstraints): RuleResult[] {
  const e: QlooEntity = { entity_id: card.entity_id, name: card.name, tags: card.tags.map((id) => ({ id })), query: { distance: card.distance_m }, properties: { price_level: card.priceLevel } };
  const v = verifyCard(e, { kind: "outing", constraints: c, slot: { day: card.slot.day, hour: card.hour } });
  return v.reasons.filter((r) => ["R-ALC", "R-QUIET", "R-ACCESS", "R-NEAR", "R-PRICE"].includes(r.rule));
}

/**
 * Constraint toggle (e.g. "in recovery" ON): re-verify every placed outing against the new case row; the ones that
 * fail are struck in place with their rule, and only those slots are refilled with the new server-side filters.
 */
export async function applyConstraints(qloo: QlooClient, prev: WeekPlan, c: CaseRow, history: PlanHistory = EMPTY_HISTORY): Promise<WeekPlan & { struck: Refusal[]; refilled: number }> {
  const placed = prev.slots.flatMap((s) => (s.card ? [s.card.entity_id] : []));
  const placedPlaces = prev.slots.flatMap((s) => (s.card && s.card.rung !== "home" ? [s.card.entity_id] : []));
  // struck entities stay in `used`, so the refill can never put them back
  const ctx: ToolContext = { qloo, case: c, history, used: new Set(placed), usedPlaces: new Set(placedPlaces), seen: new Set(placed) };
  const struck: Refusal[] = [];
  const slots: SlotOutcome[] = [];
  const refusals: Refusal[] = [...prev.refusals];
  const review: Card[] = prev.review.filter((x) => !recheckConstraints(x, c).some((r) => r.verdict === "REFUSE"));
  let refilled = 0;
  for (const s of prev.slots) {
    if (!s.card || s.slot.rung === "home") {
      slots.push(s);
      continue;
    }
    const failed = recheckConstraints(s.card, c);
    if (failed.length === 0) {
      slots.push(s);
      continue;
    }
    for (const r of failed) struck.push({ day: s.slot.day, hour: s.card.hour, entity_id: s.card.entity_id, name: s.card.name, rule: r.rule, detail: r.detail, verdict: r.verdict, struckByToggle: true });
    const r = s.slot.rung === "solo" ? await findOutings(ctx, s.slot) : await placeSocial(ctx, s.slot);
    refilled++;
    slots.push({ slot: s.slot, card: r.card, ...(r.card ? {} : { empty: r.empty }) });
    refusals.push(...r.refusals);
    review.push(...r.review);
  }
  return { week: prev.week, slots, refusals: [...refusals, ...struck], review, calls: prev.calls, struck, refilled };
}

export const dayIndex = (d: DayName) => DAYS.indexOf(d);
