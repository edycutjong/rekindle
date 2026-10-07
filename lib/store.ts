/**
 * Persistence (build-plan D4). One JSON document per case, per plan and per plan's Qloo call log, validated with zod on
 * every read and write. The schema mirrors the relational plan (cases / loves / plans / cards / refusals / qloo_calls):
 * loves are embedded in their case, cards and refusals in their plan, and the call log is its own document.
 *
 * Backend: a private Vercel Blob store (decision 2026-10-07: the Neon / Upstash marketplace integrations need the
 * account owner to accept terms in a browser; Blob is first-party and was provisioned non-interactively). Callers only
 * see the `Store` interface, so a Postgres implementation can replace it without touching them.
 *
 * The in-memory store exists for tests and for local dev without a token. It is refused on a Vercel deployment.
 */
import { z } from "zod";
import type { AgentPlan } from "./agent";
import type { QlooCallLog } from "./qloo";
import type { Card, CaseRow, PlanHistory, WeekPlan } from "./plan";
import { DAYS, type DayName } from "./verify";

/* ------------------------------------------------------------------ schema */

const day = z.enum(DAYS);
const rung = z.enum(["home", "solo", "social"]);
const verdict = z.enum(["PASS", "REFUSE", "REVIEW"]);
const ruleResult = z.object({ rule: z.string(), verdict, detail: z.string() });

export const LoveDoc = z.object({
  id: z.string(),
  text: z.string().min(1).max(120),
  qloo_id: z.string().min(1),
  qloo_kind: z.enum(["entity", "tag"]),
  entity_type: z.string().optional(),
  name: z.string().optional(),
  weight: z.number().default(1),
});

export const CaseDoc = z.object({
  id: z.string(),
  label: z.string().min(1).max(40),
  created_at: z.string(),
  point_wkt: z.string().regex(/^POINT\(-?\d+(\.\d+)? -?\d+(\.\d+)?\)$/),
  lon: z.number().min(-180).max(180),
  lat: z.number().min(-90).max(90),
  locality: z.string().max(80).default(""),
  energy: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  price_max: z.number().int().min(1).max(4),
  max_meters: z.number().int().min(300).max(10000),
  in_recovery: z.boolean(),
  need_quiet: z.boolean(),
  need_wheelchair: z.boolean(),
  /** fictional seeded profile (seed-data.md); real patient names are never entered */
  is_seed: z.boolean().default(false),
  seed_slug: z.string().optional(),
  loves: z.array(LoveDoc).min(1).max(8),
});
export type CaseDoc = z.infer<typeof CaseDoc>;

export const CardDoc = z.object({
  id: z.string(),
  plan_id: z.string(),
  day: z.number().int().min(0).max(6),
  day_name: day,
  /** scheduled hour (after any re-slot) */
  hour: z.number().int().min(0).max(23),
  /** the ladder hour the slot asked for */
  slot_hour: z.number().int().min(0).max(23),
  moved_from: z.number().int().optional(),
  rung,
  home_type: z.enum(["artist", "podcast", "book", "tv_show"]).optional(),
  /** I1: every card is a Qloo entity returned in the run that produced it */
  qloo_entity_id: z.string().min(1),
  name: z.string(),
  entity_type: z.string(),
  affinity: z.number(),
  distance_m: z.number().int().optional(),
  price_level: z.number().optional(),
  hours_text: z.string().optional(),
  address: z.string().optional(),
  geohash: z.string().optional(),
  explain_json: z.array(z.object({ entity_id: z.string(), name: z.string(), score: z.number() })),
  tags: z.array(z.string()),
  checks: z.array(ruleResult),
  verdict,
  coaching: z.string().default(""),
  coaching_by: z.enum(["llm", "template"]).optional(),
  /** who placed the card: the LLM, the deterministic fallback, a constraint-toggle refill, or a clinician swap */
  routed_by: z.enum(["llm", "fallback", "toggle", "swap"]).default("llm"),
  tool: z.string().optional(),
  tool_params: z.record(z.string(), z.unknown()).default({}),
  clinician_action: z.enum(["approved", "removed", "swapped"]).nullable().default(null),
  pleasure: z.number().int().min(0).max(10).nullable().default(null),
  mastery: z.number().int().min(0).max(10).nullable().default(null),
});
export type CardDoc = z.infer<typeof CardDoc>;

export const RefusalDoc = z.object({
  id: z.string(),
  plan_id: z.string(),
  qloo_entity_id: z.string(),
  name: z.string(),
  rule: z.string(),
  detail: z.string(),
  verdict,
  day_name: day,
  hour: z.number().int(),
  moved_to: z.number().int().optional(),
  struck_by_toggle: z.boolean().optional(),
  /** struck by the clinician gate (swap / remove), not by a verifier rule */
  by_clinician: z.enum(["swapped", "removed"]).optional(),
});
export type RefusalDoc = z.infer<typeof RefusalDoc>;

export const ReplanDiffDoc = z.object({
  /** the rated week this one was re-planned from */
  from_plan_id: z.string(),
  kept: z.array(z.object({ day: day, name: z.string() })),
  added: z.array(z.object({ day: day, name: z.string(), because: z.array(z.object({ name: z.string(), score: z.number() })) })),
  removed: z.array(z.object({ day: day, name: z.string(), reason: z.string() })),
  /** every week-2 card whose explainability names a rekindled (≥ 7) entity; `top` = it is that card's strongest input */
  ember: z.array(z.object({ from: z.string(), from_id: z.string(), to: z.string(), to_id: z.string(), day: day, score: z.number(), top: z.boolean() })),
});
export type ReplanDiffDoc = z.infer<typeof ReplanDiffDoc>;

export const PlanDoc = z.object({
  id: z.string(),
  case_id: z.string(),
  week: z.number().int().min(1),
  status: z.enum(["draft", "approved", "rated"]),
  created_at: z.string(),
  approved_at: z.string().nullable().default(null),
  parent_plan_id: z.string().nullable().default(null),
  llm_provider: z.string().nullable(),
  llm_model: z.string().nullable(),
  llm_steps: z.number().int().default(0),
  llm_ms: z.number().int().default(0),
  qloo_calls: z.number().int(),
  latency_ms: z.number().int(),
  /** signals carried into this week from the previous week's ratings */
  history: z.object({
    rekindled: z.array(z.object({ entity_id: z.string(), name: z.string(), tags: z.array(z.string()), entityType: z.string() })),
    lowRated: z.array(z.string()),
    excludeTags: z.array(z.string()),
    signalTags: z.array(z.string()),
  }),
  cards: z.array(CardDoc),
  empty_slots: z.array(z.object({ day_name: day, hour: z.number().int(), rung, reason: z.string(), routed_by: z.string().optional() })),
  refusals: z.array(RefusalDoc),
  /** REVIEW candidates held for the clinician (never placed automatically) */
  review: z.array(CardDoc),
  /** truth-boundary drops (R-ID / COACH-*) */
  dropped: z.array(z.object({ rule: z.string(), entity_id: z.string(), detail: z.string() })),
  llm_errors: z.array(z.object({ provider: z.string(), error: z.string() })).default([]),
  /** how this week was produced: the agent run, or a constraint toggle applied to a parent plan */
  origin: z.enum(["agent", "toggle", "replan"]).default("agent"),
  /** set on a rated week once it has been re-planned: the week that came from its ratings (one re-plan per week) */
  next_plan_id: z.string().nullable().default(null),
  /** re-plan diff against the rated week it came from (origin "replan", and toggles/swaps of that week) */
  diff: ReplanDiffDoc.nullable().default(null),
  /** bench runs only (scripts/bench.py, bench namespace + bench/ prefix): the arm and the verifier-input pool audit */
  bench: z
    .object({
      arm: z.enum(["B", "B-", "B-4"]),
      alcohol_screen: z.boolean(),
      exclude_set: z.enum(["14", "4"]),
      pools: z.number().int(),
      pool_entities: z.number().int(),
      /** distinct candidates Qloo returned to outing queries that carry an R-ALC deny tag / keyword (REFUSE) or a REVIEW signal */
      pool_alcohol: z.array(z.object({ entity_id: z.string(), name: z.string(), verdict: z.enum(["REFUSE", "REVIEW"]), hits: z.array(z.string()) })),
    })
    .nullable()
    .default(null),
  /** a deliberately injected failure (the Qloo-unavailable demo on /judge); never set on a normal run */
  fault: z.enum(["qloo_unreachable"]).nullable().default(null),
  /** constraint toggle that produced this plan (origin "toggle") */
  toggle: z
    .object({ changed: z.record(z.string(), z.union([z.boolean(), z.number()])), struck: z.number().int(), refilled: z.number().int(), ms: z.number().int() })
    .nullable()
    .default(null),
});
export type PlanDoc = z.infer<typeof PlanDoc>;

export const QlooCallsDoc = z.object({
  plan_id: z.string(),
  calls: z.array(
    z.object({
      path: z.string(),
      /** IDs, tags and a point only — never the key (I5) */
      params_json: z.record(z.string(), z.string()),
      status: z.number().int(),
      ms: z.number().int(),
      n_results: z.number().int(),
      at: z.string(),
    }),
  ),
});
export type QlooCallsDoc = z.infer<typeof QlooCallsDoc>;

/* ------------------------------------------------------------------ mapping */

export const newId = () => crypto.randomUUID();

export function caseRowFromDoc(d: CaseDoc): CaseRow {
  return {
    label: d.label,
    lon: d.lon,
    lat: d.lat,
    energy: d.energy,
    priceMax: d.price_max,
    maxMeters: d.max_meters,
    inRecovery: d.in_recovery,
    needQuiet: d.need_quiet,
    needWheelchair: d.need_wheelchair,
    loves: d.loves.map((l) => ({ text: l.text, qlooId: l.qloo_id, kind: l.qloo_kind, ...(l.entity_type ? { entityType: l.entity_type } : {}), ...(l.name ? { name: l.name } : {}) })),
  };
}

export function cardToDoc(planId: string, c: Card, extra: Partial<CardDoc> = {}): CardDoc {
  return CardDoc.parse({
    id: newId(),
    plan_id: planId,
    day: DAYS.indexOf(c.slot.day),
    day_name: c.slot.day,
    hour: c.hour,
    slot_hour: c.slot.hour,
    ...(c.movedFrom !== undefined ? { moved_from: c.movedFrom } : {}),
    rung: c.rung,
    ...(c.slot.homeType ? { home_type: c.slot.homeType } : {}),
    qloo_entity_id: c.entity_id,
    name: c.name,
    entity_type: c.entityType,
    affinity: c.affinity,
    ...(c.distance_m !== undefined ? { distance_m: c.distance_m } : {}),
    ...(c.priceLevel !== undefined ? { price_level: c.priceLevel } : {}),
    ...(c.hoursText ? { hours_text: c.hoursText } : {}),
    ...(c.address ? { address: c.address } : {}),
    ...(c.geohash ? { geohash: c.geohash } : {}),
    explain_json: c.why,
    tags: c.tags,
    checks: c.checks,
    verdict: c.verdict,
    ...extra,
  });
}

export function cardFromDoc(d: CardDoc): Card {
  return {
    slot: { day: d.day_name, hour: d.slot_hour, rung: d.rung, ...(d.home_type ? { homeType: d.home_type } : {}) },
    hour: d.hour,
    ...(d.moved_from !== undefined ? { movedFrom: d.moved_from } : {}),
    rung: d.rung,
    entity_id: d.qloo_entity_id,
    name: d.name,
    entityType: d.entity_type,
    affinity: d.affinity,
    ...(d.distance_m !== undefined ? { distance_m: d.distance_m } : {}),
    ...(d.price_level !== undefined ? { priceLevel: d.price_level } : {}),
    ...(d.hours_text ? { hoursText: d.hours_text } : {}),
    ...(d.address ? { address: d.address } : {}),
    ...(d.geohash ? { geohash: d.geohash } : {}),
    tags: d.tags,
    why: d.explain_json,
    verdict: d.verdict,
    checks: d.checks.map((x) => ({ ...x, rule: x.rule as Card["checks"][number]["rule"] })),
  };
}

export function planDocFromAgent(p: AgentPlan, o: { id?: string; caseId: string; history: PlanHistory; calls: number; parentPlanId?: string | null }): PlanDoc {
  const id = o.id ?? newId();
  return PlanDoc.parse({
    id,
    case_id: o.caseId,
    week: p.week,
    status: "draft",
    created_at: new Date().toISOString(),
    approved_at: null,
    parent_plan_id: o.parentPlanId ?? null,
    llm_provider: p.llm?.provider ?? null,
    llm_model: p.llm?.model ?? null,
    llm_steps: p.llmSteps,
    llm_ms: p.llmMs,
    qloo_calls: o.calls,
    latency_ms: p.latencyMs,
    history: o.history,
    cards: p.slots.flatMap((s) => (s.card ? [cardToDoc(id, s.card, { coaching: s.coaching ?? "", ...(s.coachingBy ? { coaching_by: s.coachingBy } : {}), routed_by: s.routedBy, tool: s.tool, tool_params: s.params })] : [])),
    empty_slots: p.slots.filter((s) => !s.card).map((s) => ({ day_name: s.slot.day, hour: s.slot.hour, rung: s.slot.rung, reason: s.empty ?? "no verified candidate", routed_by: s.routedBy })),
    refusals: p.refusals.map((r) => ({ id: newId(), plan_id: id, qloo_entity_id: r.entity_id, name: r.name, rule: r.rule, detail: r.detail, verdict: r.verdict, day_name: r.day, hour: r.hour, ...(r.movedTo !== undefined ? { moved_to: r.movedTo } : {}), ...(r.struckByToggle ? { struck_by_toggle: true } : {}) })),
    review: p.review.map((c) => cardToDoc(id, c, { routed_by: "llm" })),
    dropped: p.dropped,
    llm_errors: p.llmErrors,
  });
}

/**
 * A constraint toggle's result as a new plan document (parent = the plan it was applied to). Cards that survived keep
 * their coaching and routing; refilled slots are marked `routed_by: "toggle"` with a template dose line. Refusals keep
 * the parent's plus the newly struck ones (`struck_by_toggle`) and the refill's.
 */
export function planDocFromToggle(
  parent: PlanDoc,
  w: WeekPlan,
  o: { caseId: string; changed: Record<string, boolean | number>; struck: number; refilled: number; ms: number; calls: number; coach: (c: Card) => string },
): PlanDoc {
  const id = newId();
  const prior = new Map(parent.cards.map((c) => [`${c.day_name}|${c.qloo_entity_id}`, c]));
  return PlanDoc.parse({
    ...parent,
    id,
    case_id: o.caseId,
    status: "draft",
    created_at: new Date().toISOString(),
    approved_at: null,
    parent_plan_id: parent.id,
    qloo_calls: o.calls,
    latency_ms: o.ms,
    origin: "toggle",
    next_plan_id: null,
    toggle: { changed: o.changed, struck: o.struck, refilled: o.refilled, ms: o.ms },
    cards: w.slots.flatMap((s) => {
      if (!s.card) return [];
      const kept = prior.get(`${s.slot.day}|${s.card.entity_id}`);
      if (kept) return [{ ...kept, id: newId(), plan_id: id }];
      return [cardToDoc(id, s.card, { coaching: o.coach(s.card), coaching_by: "template", routed_by: "toggle", tool: s.slot.rung === "social" ? "placeSocial" : "findOutings", tool_params: { day: s.slot.day } })];
    }),
    empty_slots: w.slots.filter((s) => !s.card).map((s) => ({ day_name: s.slot.day, hour: s.slot.hour, rung: s.slot.rung, reason: s.empty ?? "no verified candidate", routed_by: "toggle" })),
    refusals: w.refusals.map((r) => ({ id: newId(), plan_id: id, qloo_entity_id: r.entity_id, name: r.name, rule: r.rule, detail: r.detail, verdict: r.verdict, day_name: r.day, hour: r.hour, ...(r.movedTo !== undefined ? { moved_to: r.movedTo } : {}), ...(r.struckByToggle ? { struck_by_toggle: true } : {}), ...(r.byClinician ? { by_clinician: r.byClinician } : {}) })),
    review: w.review.map((c) => cardToDoc(id, c, { routed_by: "toggle" })),
  });
}

/** Rebuild the in-memory week (for the constraint toggle and the re-plan) from a stored plan. */
export function weekPlanFromDoc(d: PlanDoc): WeekPlan {
  const cards = new Map(d.cards.map((c) => [c.day_name, c]));
  const empties = new Map(d.empty_slots.map((e) => [e.day_name, e]));
  const days = [...new Set([...cards.keys(), ...empties.keys()])].sort((a, b) => DAYS.indexOf(a) - DAYS.indexOf(b)) as DayName[];
  return {
    week: d.week,
    slots: days.map((dn) => {
      const c = cards.get(dn);
      if (c) return { slot: cardFromDoc(c).slot, card: cardFromDoc(c) };
      const e = empties.get(dn)!;
      return { slot: { day: dn, hour: e.hour, rung: e.rung }, card: null, empty: e.reason };
    }),
    refusals: d.refusals.map((r) => ({ day: r.day_name, hour: r.hour, entity_id: r.qloo_entity_id, name: r.name, rule: r.rule, detail: r.detail, verdict: r.verdict, ...(r.moved_to !== undefined ? { movedTo: r.moved_to } : {}), ...(r.struck_by_toggle ? { struckByToggle: true } : {}), ...(r.by_clinician ? { byClinician: r.by_clinician } : {}) })),
    review: d.review.map(cardFromDoc),
    calls: [],
  };
}

export function callsDoc(planId: string, calls: QlooCallLog[]): QlooCallsDoc {
  return QlooCallsDoc.parse({ plan_id: planId, calls: calls.map((c) => ({ path: c.path, params_json: c.params, status: c.status, ms: c.ms, n_results: c.n_results, at: c.at })) });
}

/* ------------------------------------------------------------------ store */

export interface Store {
  readonly kind: "blob" | "memory";
  putCase(d: CaseDoc): Promise<void>;
  getCase(id: string): Promise<CaseDoc | null>;
  putPlan(d: PlanDoc): Promise<void>;
  getPlan(id: string): Promise<PlanDoc | null>;
  putCalls(d: QlooCallsDoc): Promise<void>;
  getCalls(planId: string): Promise<QlooCallsDoc | null>;
  /** newest first */
  listPlanIds(limit?: number): Promise<string[]>;
}

const ID_RE = /^[0-9a-f-]{36}$/i;
const safeId = (id: string) => {
  if (!ID_RE.test(id)) throw new Error("invalid id");
  return id;
};
/** Store prefixes: "" for the product, "bench/" for scripts/bench.py runs so they never mix into the public receipts. */
export type StorePrefix = "" | "bench/";
const pathsFor = (prefix: StorePrefix) => ({
  case: (id: string) => `${prefix}cases/${safeId(id)}.json`,
  plan: (id: string) => `${prefix}plans/${safeId(id)}.json`,
  calls: (id: string) => `${prefix}calls/${safeId(id)}.json`,
  plans: `${prefix}plans/`,
});

export class MemoryStore implements Store {
  readonly kind = "memory" as const;
  private readonly docs: Map<string, { at: number; body: string }>;
  private readonly tick: { n: number };
  private readonly paths: ReturnType<typeof pathsFor>;
  constructor(
    readonly prefix: StorePrefix = "",
    shared?: { docs: Map<string, { at: number; body: string }>; tick: { n: number } },
  ) {
    this.paths = pathsFor(prefix);
    this.docs = shared?.docs ?? new Map();
    this.tick = shared?.tick ?? { n: 0 };
  }
  /** the same backing map under another prefix (tests: bench and product share one memory store) */
  withPrefix(prefix: StorePrefix): MemoryStore {
    return new MemoryStore(prefix, { docs: this.docs, tick: this.tick });
  }
  private async put(path: string, v: unknown) {
    this.docs.set(path, { at: ++this.tick.n, body: JSON.stringify(v) });
  }
  private async get(path: string): Promise<unknown | null> {
    const d = this.docs.get(path);
    return d ? JSON.parse(d.body) : null;
  }
  putCase = (d: CaseDoc) => this.put(this.paths.case(d.id), CaseDoc.parse(d));
  getCase = async (id: string) => parseOrNull(CaseDoc, await this.get(this.paths.case(id)));
  putPlan = (d: PlanDoc) => this.put(this.paths.plan(d.id), PlanDoc.parse(d));
  getPlan = async (id: string) => parseOrNull(PlanDoc, await this.get(this.paths.plan(id)));
  putCalls = (d: QlooCallsDoc) => this.put(this.paths.calls(d.plan_id), QlooCallsDoc.parse(d));
  getCalls = async (id: string) => parseOrNull(QlooCallsDoc, await this.get(this.paths.calls(id)));
  async listPlanIds(limit = 50) {
    return [...this.docs.entries()]
      .filter(([k]) => k.startsWith(this.paths.plans))
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, limit)
      .map(([k]) => k.slice(this.paths.plans.length, -5));
  }
}

function parseOrNull<T>(schema: z.ZodType<T>, v: unknown): T | null {
  return v === null ? null : schema.parse(v);
}

/** Private Vercel Blob store. Reads bypass the CDN cache so a reload always shows the latest write. */
export class BlobStore implements Store {
  readonly kind = "blob" as const;
  private readonly paths: ReturnType<typeof pathsFor>;
  constructor(
    private readonly token: string,
    readonly prefix: StorePrefix = "",
  ) {
    this.paths = pathsFor(prefix);
  }

  private async put(path: string, v: unknown) {
    const { put } = await import("@vercel/blob");
    await put(path, JSON.stringify(v), { access: "private", token: this.token, contentType: "application/json", addRandomSuffix: false, allowOverwrite: true });
  }
  private async get(path: string): Promise<unknown | null> {
    const { get } = await import("@vercel/blob");
    const r = await get(path, { access: "private", token: this.token, useCache: false });
    if (!r || !r.stream) return null;
    return JSON.parse(await new Response(r.stream).text());
  }
  putCase = (d: CaseDoc) => this.put(this.paths.case(d.id), CaseDoc.parse(d));
  getCase = async (id: string) => parseOrNull(CaseDoc, await this.get(this.paths.case(id)));
  putPlan = (d: PlanDoc) => this.put(this.paths.plan(d.id), PlanDoc.parse(d));
  getPlan = async (id: string) => parseOrNull(PlanDoc, await this.get(this.paths.plan(id)));
  putCalls = (d: QlooCallsDoc) => this.put(this.paths.calls(d.plan_id), QlooCallsDoc.parse(d));
  getCalls = async (id: string) => parseOrNull(QlooCallsDoc, await this.get(this.paths.calls(id)));
  async listPlanIds(limit = 50) {
    const { list } = await import("@vercel/blob");
    const r = await list({ prefix: this.paths.plans, token: this.token, limit: 1000 });
    return r.blobs
      .sort((a, b) => +new Date(b.uploadedAt) - +new Date(a.uploadedAt))
      .slice(0, limit)
      .map((b) => b.pathname.slice(this.paths.plans.length, -5));
  }
}

let memory: MemoryStore | null = null;

/** Blob when BLOB_READ_WRITE_TOKEN is set; in-memory only off Vercel (local dev / tests). */
export function storeFromEnv(env: Record<string, string | undefined> = process.env, prefix: StorePrefix = ""): Store {
  const token = env.BLOB_READ_WRITE_TOKEN;
  if (token) return new BlobStore(token, prefix);
  if (env.VERCEL) throw new Error("BLOB_READ_WRITE_TOKEN is not set on this deployment; refusing the in-memory store");
  memory ??= new MemoryStore();
  return prefix ? memory.withPrefix(prefix) : memory;
}
