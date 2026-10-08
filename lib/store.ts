/**
 * Persistence. One JSON document per case, per plan and per plan's Qloo call log, validated with zod on
 * every read and write. The schema mirrors the relational plan (cases / loves / plans / cards / refusals / qloo_calls):
 * loves are embedded in their case, cards and refusals in their plan, and the call log is its own document.
 *
 * Backends, chosen by `storeFromEnv` (callers only see the `Store` interface):
 *   redis   Upstash Redis (KV_REST_API_URL + KV_REST_API_TOKEN, or UPSTASH_REDIS_REST_*): one key per document at the
 *           same path Blob uses, SET NX / compare-and-set run claims, and a newest-first sorted set of plan ids instead
 *           of a list(). a2a r06: Vercel Hobby allows 2,000 Blob advanced ops per rolling 30 days and locks the store
 *           for 30 days past that; a judge's click-through cost ~21 of them.
 *   blob    a private Vercel Blob store (BLOB_READ_WRITE_TOKEN): the original backend, now the fallback when Redis is
 *           not configured, and the rollback (`STORE_BACKEND=blob`) when it is.
 *   memory  tests and local dev without either. Refused on a Vercel deployment.
 */
import { Redis } from "@upstash/redis";
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
  /** fictional seeded profile (fixtures/profiles.csv); real patient names are never entered */
  is_seed: z.boolean().default(false),
  seed_slug: z.string().optional(),
  loves: z.array(LoveDoc).min(1).max(8),
  /** SHA-256 of the creating browser's httpOnly `rk_owner` cookie (lib/owner.ts); absent = created before ownership,
   *  read-only for everyone */
  owner_hash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
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
  routed_by: z.enum(["llm", "fallback", "toggle", "swap", "kept"]).default("llm"),
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
  kept: z.array(z.object({ day: day, name: z.string(), reason: z.string().optional() })),
  added: z.array(z.object({ day: day, name: z.string(), because: z.array(z.object({ name: z.string(), score: z.number() })) })),
  removed: z.array(z.object({ day: day, name: z.string(), reason: z.string() })),
  /** rated ≥ 7 last week and not kept: this week's Qloo signals */
  signals: z.array(z.object({ day: day, name: z.string(), reason: z.string() })).default([]),
  /** the live re-check of the top-rated activity (kept in its slot, or why not) */
  kept_check: z.object({ entity_id: z.string(), name: z.string(), ok: z.boolean(), detail: z.string() }).nullable().default(null),
  /** every week-2 card whose explainability names a rekindled (≥ 7) entity; `top` = it is that card's strongest input */
  ember: z.array(z.object({ from: z.string(), from_id: z.string(), to: z.string(), to_id: z.string(), day: day, score: z.number(), top: z.boolean(), margin: z.number().optional() })),
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
  /** "provider:model" whose coaching call won the race (null: template coaching, or a plan from before QA round 3) */
  coach_llm: z.string().nullable().default(null),
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
    struck: z.array(z.string()).default([]),
  }),
  cards: z.array(CardDoc),
  empty_slots: z.array(
    z.object({
      day_name: day,
      hour: z.number().int(),
      rung,
      reason: z.string(),
      routed_by: z.string().optional(),
      /** live diagnosis: verified candidates if one optional filter were relaxed (lib/plan.ts diagnoseEmpty) */
      relax: z.object({ quiet: z.number().int().optional(), wheelchair: z.number().int().optional(), price: z.number().int().optional() }).optional(),
    }),
  ),
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
  /** set on a draft week once a constraint toggle replaced it: the newer week (the old one can no longer be approved,
   *  printed, toggled or re-planned; QA round 3) */
  superseded_by: z.string().nullable().default(null),
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

/**
 * One agent run per week: week 1 per case (QA round 1: a reload mid-stream started a second full run) and one re-plan
 * per rated week (QA round 2: two tabs re-planned the same week twice). Claimed with a create-only write before the
 * run starts (`Store.claimRun`) and updated when it ends; the routes read it before the rate limiter.
 */
export const RunDoc = z.object({
  case_id: z.string(),
  /** set on a re-plan marker: the rated week being re-planned (marker path runs/replan-<id>) */
  parent_plan_id: z.string().nullable().default(null),
  status: z.enum(["running", "done", "failed"]),
  plan_id: z.string().nullable().default(null),
  started_at: z.string(),
  updated_at: z.string(),
});
export type RunDoc = z.infer<typeof RunDoc>;
export type RunDocIn = z.input<typeof RunDoc>;

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
    coach_llm: p.coachedBy ? `${p.coachedBy.provider}:${p.coachedBy.model}` : null,
    llm_steps: p.llmSteps,
    llm_ms: p.llmMs,
    qloo_calls: o.calls,
    latency_ms: p.latencyMs,
    history: o.history,
    cards: p.slots.flatMap((s) => (s.card ? [cardToDoc(id, s.card, { coaching: s.coaching ?? "", ...(s.coachingBy ? { coaching_by: s.coachingBy } : {}), routed_by: s.routedBy, tool: s.tool, tool_params: s.params })] : [])),
    empty_slots: p.slots.filter((s) => !s.card).map((s) => ({ day_name: s.slot.day, hour: s.slot.hour, rung: s.slot.rung, reason: s.empty ?? "no verified candidate", routed_by: s.routedBy, ...(s.relax ? { relax: s.relax } : {}) })),
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
    superseded_by: null,
    toggle: { changed: o.changed, struck: o.struck, refilled: o.refilled, ms: o.ms },
    cards: w.slots.flatMap((s) => {
      if (!s.card) return [];
      const kept = prior.get(`${s.slot.day}|${s.card.entity_id}`);
      if (kept) return [{ ...kept, id: newId(), plan_id: id }];
      return [cardToDoc(id, s.card, { coaching: o.coach(s.card), coaching_by: "template", routed_by: "toggle", tool: s.slot.rung === "social" ? "placeSocial" : "findOutings", tool_params: { day: s.slot.day } })];
    }),
    empty_slots: w.slots.filter((s) => !s.card).map((s) => ({ day_name: s.slot.day, hour: s.slot.hour, rung: s.slot.rung, reason: s.empty ?? "no verified candidate", routed_by: "toggle", ...(s.relax ? { relax: s.relax } : {}) })),
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
      return { slot: { day: dn, hour: e.hour, rung: e.rung }, card: null, empty: e.reason, ...(e.relax ? { relax: e.relax } : {}) };
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
  readonly kind: "redis" | "blob" | "memory";
  putCase(d: CaseDoc): Promise<void>;
  getCase(id: string): Promise<CaseDoc | null>;
  putPlan(d: PlanDoc): Promise<void>;
  getPlan(id: string): Promise<PlanDoc | null>;
  putCalls(d: QlooCallsDoc): Promise<void>;
  getCalls(planId: string): Promise<QlooCallsDoc | null>;
  /** writes the marker at its path (week 1 → runs/<case>, re-plan → runs/replan-<parent plan>) */
  putRun(d: RunDocIn): Promise<void>;
  getRun(caseId: string): Promise<RunDoc | null>;
  getReplanRun(planId: string): Promise<RunDoc | null>;
  /**
   * Create-only claim of a run marker: writes `d` only if no marker exists or the existing one is `reclaimable`
   * (failed / stale), atomically against a concurrent claim. Returns null when claimed, else the marker that blocks it.
   */
  claimRun(d: RunDocIn, reclaimable: (cur: RunDoc) => boolean): Promise<RunDoc | null>;
  /**
   * Newest first by `created_at`. Redis and memory leave out weeks a constraint toggle replaced (`superseded_by`) and
   * the injected-outage demo (`fault`); Blob lists every plan by upload time, so callers still filter both.
   */
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
  run: (id: string) => `${prefix}runs/${safeId(id)}.json`,
  replanRun: (planId: string) => `${prefix}runs/replan-${safeId(planId)}.json`,
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
  private runPath = (d: RunDocIn) => (d.parent_plan_id ? this.paths.replanRun(d.parent_plan_id) : this.paths.run(d.case_id));
  putRun = (d: RunDocIn) => this.put(this.runPath(d), RunDoc.parse(d));
  getRun = async (id: string) => parseOrNull(RunDoc, await this.get(this.paths.run(id)));
  getReplanRun = async (id: string) => parseOrNull(RunDoc, await this.get(this.paths.replanRun(id)));
  /** synchronous read-then-write: no await between them, so two concurrent claims cannot both win */
  async claimRun(d: RunDocIn, reclaimable: (cur: RunDoc) => boolean): Promise<RunDoc | null> {
    const path = this.runPath(d);
    const raw = this.docs.get(path);
    const cur = raw ? RunDoc.parse(JSON.parse(raw.body)) : null;
    if (cur && !reclaimable(cur)) return cur;
    this.docs.set(path, { at: ++this.tick.n, body: JSON.stringify(RunDoc.parse(d)) });
    return null;
  }
  /** the Redis contract (tests/store-contract.test.ts): newest created first, replaced weeks and the outage demo left out */
  async listPlanIds(limit = 50) {
    return [...this.docs.entries()]
      .filter(([k]) => k.startsWith(this.paths.plans))
      .map(([k, v]) => ({ id: k.slice(this.paths.plans.length, -5), at: v.at, p: JSON.parse(v.body) as Pick<PlanDoc, "created_at" | "superseded_by" | "fault"> }))
      .filter((x) => !x.p.superseded_by && !x.p.fault)
      .sort((a, b) => planScore(b.p.created_at) - planScore(a.p.created_at) || b.at - a.at)
      .slice(0, limit)
      .map((x) => x.id);
  }
}

/** sorted-set score of a plan: its creation time (a plan written with an unparseable date sorts as oldest) */
const planScore = (createdAt: string) => {
  const t = Date.parse(createdAt);
  return Number.isFinite(t) ? t : 0;
};

/** A stored document that no longer parses is the server's fault: never let its ZodError reach http.ts as a client 400. */
export class CorruptDocument extends Error {}

/**
 * a2a r06 safe mode: the backend refused or could not be reached (Blob suspended or rate limited, Upstash over its
 * request quota, a 5xx, the network). Distinct from CorruptDocument (500) and from "not found" (null): http.ts answers
 * 503 with retry-after, and pages say "unavailable right now" instead of "Not found".
 */
export class StoreUnavailable extends Error {
  constructor(readonly reason?: unknown) {
    super(`store unavailable${reason instanceof Error ? ` (${reason.message.slice(0, 120)})` : ""}`);
    this.name = "StoreUnavailable";
  }
}
/** wraps only a backend SDK call: zod, "invalid id" and CorruptDocument keep their meaning */
export const toStoreError = (e: unknown) => (e instanceof StoreUnavailable || e instanceof CorruptDocument ? e : new StoreUnavailable(e));
async function sdk<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    throw toStoreError(e);
  }
}

function parseOrNull<T>(schema: z.ZodType<T>, v: unknown): T | null {
  if (v === null) return null;
  const r = schema.safeParse(v);
  if (!r.success) throw new CorruptDocument(`stored document failed validation (${r.error.issues.length} issue(s))`);
  return r.data;
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
    const body = JSON.stringify(v);
    const { put } = await import("@vercel/blob");
    await sdk(() => put(path, body, { access: "private", token: this.token, contentType: "application/json", addRandomSuffix: false, allowOverwrite: true }));
  }
  private async get(path: string): Promise<unknown | null> {
    const { get } = await import("@vercel/blob");
    const text = await sdk(async () => {
      const r = await get(path, { access: "private", token: this.token, useCache: false });
      return r && r.stream ? new Response(r.stream).text() : null;
    });
    return text === null ? null : parseStored(text);
  }
  putCase = (d: CaseDoc) => this.put(this.paths.case(d.id), CaseDoc.parse(d));
  getCase = async (id: string) => parseOrNull(CaseDoc, await this.get(this.paths.case(id)));
  putPlan = (d: PlanDoc) => this.put(this.paths.plan(d.id), PlanDoc.parse(d));
  getPlan = async (id: string) => parseOrNull(PlanDoc, await this.get(this.paths.plan(id)));
  putCalls = (d: QlooCallsDoc) => this.put(this.paths.calls(d.plan_id), QlooCallsDoc.parse(d));
  getCalls = async (id: string) => parseOrNull(QlooCallsDoc, await this.get(this.paths.calls(id)));
  private runPath = (d: RunDocIn) => (d.parent_plan_id ? this.paths.replanRun(d.parent_plan_id) : this.paths.run(d.case_id));
  putRun = (d: RunDocIn) => this.put(this.runPath(d), RunDoc.parse(d));
  getRun = async (id: string) => parseOrNull(RunDoc, await this.get(this.paths.run(id)));
  getReplanRun = async (id: string) => parseOrNull(RunDoc, await this.get(this.paths.replanRun(id)));
  /** create-only put (allowOverwrite false) when no marker exists; an ETag-conditional put over a reclaimable one */
  async claimRun(d: RunDocIn, reclaimable: (cur: RunDoc) => boolean): Promise<RunDoc | null> {
    const { get, put, BlobPreconditionFailedError } = await import("@vercel/blob");
    const path = this.runPath(d);
    const next = JSON.stringify(RunDoc.parse(d));
    const r = await sdk(async () => {
      const got = await get(path, { access: "private", token: this.token, useCache: false });
      return got && got.stream ? { text: await new Response(got.stream).text(), etag: got.blob.etag } : null;
    });
    let etag: string | undefined;
    if (r) {
      const cur = parseOrNull(RunDoc, parseStored(r.text))!;
      if (!reclaimable(cur)) return cur;
      etag = r.etag;
    }
    try {
      await put(path, next, { access: "private", token: this.token, contentType: "application/json", addRandomSuffix: false, allowOverwrite: !!etag, ...(etag ? { ifMatch: etag } : {}) });
      return null;
    } catch (e) {
      // another request claimed it between our read and our write
      if (e instanceof BlobPreconditionFailedError || (e instanceof Error && /already exists/i.test(e.message))) {
        const now = await this.get(path).catch(() => null);
        return now ? RunDoc.parse(now) : RunDoc.parse(d);
      }
      throw toStoreError(e);
    }
  }
  async listPlanIds(limit = 50) {
    const { list } = await import("@vercel/blob");
    const r = await sdk(() => list({ prefix: this.paths.plans, token: this.token, limit: 1000 }));
    return r.blobs
      .sort((a, b) => +new Date(b.uploadedAt) - +new Date(a.uploadedAt))
      .slice(0, limit)
      .map((b) => b.pathname.slice(this.paths.plans.length, -5));
  }
}

/* ------------------------------------------------------------------ redis */

/** The subset of the @upstash/redis client RedisStore and RedisDailyCounter use (tests run them on an in-process fake). */
export interface RedisBatch {
  set(key: string, value: string): RedisBatch;
  zadd(key: string, sm: { score: number; member: string }): RedisBatch;
  zrem(key: string, member: string): RedisBatch;
  incr(key: string): RedisBatch;
  expire(key: string, seconds: number): RedisBatch;
  exec<T extends unknown[] = unknown[]>(): Promise<T>;
}
export interface RedisLike {
  get<T = string>(key: string): Promise<T | null>;
  set(key: string, value: string, opts?: { nx: true }): Promise<unknown>;
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
  zrange(key: string, start: number, stop: number, opts: { rev: true }): Promise<unknown[]>;
  ping(): Promise<string>;
  /** MULTI/EXEC: the commands run together, in order */
  multi(): RedisBatch;
  /** non-transactional batch: one HTTP round trip */
  pipeline(): RedisBatch;
}

/** the ifMatch of a Blob put: replace the marker only if it is still the one we read */
export const CAS_SCRIPT = "if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('SET', KEYS[1], ARGV[2]) return 1 end return 0";

/** Preview (and `vercel dev`) deployments share the production database, so they write under `preview/`. */
export const envKeyPrefix = (env: Record<string, string | undefined> = process.env) => (env.VERCEL_ENV && env.VERCEL_ENV !== "production" ? "preview/" : "");

const redisClients = new Map<string, RedisLike>();

/**
 * The Redis client when it is configured (Vercel Marketplace names first, then Upstash's own), else null.
 * `STORE_BACKEND=blob` is the rollback lever: it ignores Redis even when the variables exist.
 */
export function redisFromEnv(env: Record<string, string | undefined> = process.env): RedisLike | null {
  if (env.STORE_BACKEND === "blob") return null;
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  const key = `${url}|${token}`;
  let r = redisClients.get(key);
  if (!r) {
    // values are our own JSON strings, parsed by zod on the way out: no client-side deserialization
    r = new Redis({ url, token, automaticDeserialization: false, enableTelemetry: false });
    redisClients.set(key, r);
  }
  return r;
}

/**
 * Upstash Redis: each document is one string key at the same path the Blob store uses (plus `preview/` off
 * production), zod-validated on every read and write. Plans are also indexed in a sorted set scored by `created_at`,
 * which never holds a superseded week or the outage demo, so the receipts never need a list().
 */
export class RedisStore implements Store {
  readonly kind = "redis" as const;
  private readonly paths: ReturnType<typeof pathsFor>;
  constructor(
    private readonly r: RedisLike,
    readonly prefix: StorePrefix = "",
    private readonly envPrefix = envKeyPrefix(),
  ) {
    this.paths = pathsFor(prefix);
  }
  private k = (path: string) => this.envPrefix + path;
  private idx = () => this.k(`${this.prefix}idx/plans`);
  private async getJson(path: string): Promise<unknown | null> {
    const s = await sdk(() => this.r.get<string>(this.k(path)));
    return s === null || s === undefined ? null : parseStored(s);
  }
  private async setJson(path: string, v: unknown) {
    const body = JSON.stringify(v);
    await sdk(() => this.r.set(this.k(path), body));
  }
  putCase = (d: CaseDoc) => this.setJson(this.paths.case(d.id), CaseDoc.parse(d));
  getCase = async (id: string) => parseOrNull(CaseDoc, await this.getJson(this.paths.case(id)));
  /** the document and its index entry in one MULTI: a replaced week leaves the index as it is written */
  async putPlan(d: PlanDoc) {
    const doc = PlanDoc.parse(d);
    const m = this.r.multi().set(this.k(this.paths.plan(doc.id)), JSON.stringify(doc));
    if (doc.superseded_by || doc.fault) m.zrem(this.idx(), doc.id);
    else m.zadd(this.idx(), { score: planScore(doc.created_at), member: doc.id });
    await sdk(() => m.exec());
  }
  getPlan = async (id: string) => parseOrNull(PlanDoc, await this.getJson(this.paths.plan(id)));
  putCalls = (d: QlooCallsDoc) => this.setJson(this.paths.calls(d.plan_id), QlooCallsDoc.parse(d));
  getCalls = async (id: string) => parseOrNull(QlooCallsDoc, await this.getJson(this.paths.calls(id)));
  private runPath = (d: RunDocIn) => (d.parent_plan_id ? this.paths.replanRun(d.parent_plan_id) : this.paths.run(d.case_id));
  putRun = (d: RunDocIn) => this.setJson(this.runPath(d), RunDoc.parse(d));
  getRun = async (id: string) => parseOrNull(RunDoc, await this.getJson(this.paths.run(id)));
  getReplanRun = async (id: string) => parseOrNull(RunDoc, await this.getJson(this.paths.replanRun(id)));
  /** SET NX when no marker exists; a compare-and-set script over a reclaimable one; a lost race returns the winner */
  async claimRun(d: RunDocIn, reclaimable: (cur: RunDoc) => boolean): Promise<RunDoc | null> {
    const key = this.k(this.runPath(d));
    const next = JSON.stringify(RunDoc.parse(d));
    const raw = await sdk(() => this.r.get<string>(key));
    if (raw !== null && raw !== undefined) {
      const cur = parseOrNull(RunDoc, parseStored(raw))!;
      if (!reclaimable(cur)) return cur;
      if (Number(await sdk(() => this.r.eval(CAS_SCRIPT, [key], [raw, next]))) === 1) return null;
    } else if ((await sdk(() => this.r.set(key, next, { nx: true }))) === "OK") return null;
    // another request claimed it between our read and our write
    const now = await sdk(() => this.r.get<string>(key));
    return now === null || now === undefined ? RunDoc.parse(d) : parseOrNull(RunDoc, parseStored(now))!;
  }
  async listPlanIds(limit = 50) {
    if (limit <= 0) return [];
    return (await sdk(() => this.r.zrange(this.idx(), 0, limit - 1, { rev: true }))).map(String);
  }
}

/** a stored string that is not JSON is a corrupt document (a server fault), not the client's "invalid JSON" */
function parseStored(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    throw new CorruptDocument("stored document is not JSON");
  }
}

/* ------------------------------------------------------------------ safe mode */

/** how long a failing backend is left alone before the next request probes it again */
export const CIRCUIT_MS = 5 * 60_000;

/**
 * a2a r06 safe mode. When the backend throws StoreUnavailable, this instance opens a 5-minute circuit and new work
 * moves to its own memory: seed → plan → toggle → approve → rate → re-plan keep running live (Qloo and the LLM are
 * still called) under a banner that says the week is not saved. While degraded, a document that is not in memory is
 * "unavailable" (503 / an honest page), never "missing" (404). Documents written during the outage stay readable from
 * this instance's memory after the backend recovers.
 */
export class FailoverStore implements Store {
  private openUntil = 0;
  constructor(
    readonly primary: Store,
    readonly mem: MemoryStore,
    private readonly now: () => number = Date.now,
  ) {}
  get kind() {
    return this.primary.kind;
  }
  degraded = () => this.now() < this.openUntil;
  private async w<T>(op: (s: Store) => Promise<T>): Promise<T> {
    if (!this.degraded()) {
      try {
        return await op(this.primary);
      } catch (e) {
        if (!(e instanceof StoreUnavailable)) throw e;
        this.openUntil = this.now() + CIRCUIT_MS;
        console.error(`store ${this.primary.kind} unavailable; per-instance memory for ${CIRCUIT_MS / 60_000} min`, e.reason ?? e);
      }
    }
    return op(this.mem);
  }
  /** primary, then this instance's memory; `strict`: a miss while degraded is unavailable, not missing */
  private async r<T>(op: (s: Store) => Promise<T | null>, strict: boolean): Promise<T | null> {
    const v = await this.w(op);
    if (v !== null) return v;
    const m = await op(this.mem);
    if (m === null && strict && this.degraded()) throw new StoreUnavailable();
    return m;
  }
  putCase = (d: CaseDoc) => this.w((s) => s.putCase(d));
  getCase = (id: string) => this.r((s) => s.getCase(id), true);
  putPlan = (d: PlanDoc) => this.w((s) => s.putPlan(d));
  getPlan = (id: string) => this.r((s) => s.getPlan(id), true);
  putCalls = (d: QlooCallsDoc) => this.w((s) => s.putCalls(d));
  getCalls = (id: string) => this.r((s) => s.getCalls(id), false);
  putRun = (d: RunDocIn) => this.w((s) => s.putRun(d));
  /** null = "no run yet", a normal answer; a marker written during an outage is still found after it */
  getRun = (id: string) => this.r((s) => s.getRun(id), false);
  getReplanRun = (id: string) => this.r((s) => s.getReplanRun(id), false);
  claimRun = (d: RunDocIn, f: (c: RunDoc) => boolean) => this.w((s) => s.claimRun(d, f));
  listPlanIds = (limit?: number) => this.w((s) => s.listPlanIds(limit));
}

/** STORE_FAULT=unavailable (never honoured on production): every backend call fails, to exercise safe mode end to end */
class UnavailableStore implements Store {
  constructor(readonly kind: Store["kind"]) {}
  private no = async (): Promise<never> => {
    throw new StoreUnavailable(new Error("STORE_FAULT=unavailable (injected)"));
  };
  putCase = this.no;
  getCase = this.no;
  putPlan = this.no;
  getPlan = this.no;
  putCalls = this.no;
  getCalls = this.no;
  putRun = this.no;
  getRun = this.no;
  getReplanRun = this.no;
  claimRun = this.no;
  listPlanIds = this.no;
}

export const storeFaultInjected = (env: Record<string, string | undefined> = process.env) => env.STORE_FAULT === "unavailable" && env.VERCEL_ENV !== "production";

/* ------------------------------------------------------------------ selection */

/** one in-memory store and one FailoverStore per backend + prefix, per process (dev compiles each route separately) */
const g = globalThis as typeof globalThis & { __rekindleMemory?: MemoryStore; __rekindleFailover?: Map<string, FailoverStore> };

const memoryFor = (prefix: StorePrefix) => {
  g.__rekindleMemory ??= new MemoryStore();
  return prefix ? g.__rekindleMemory.withPrefix(prefix) : g.__rekindleMemory;
};

function failover(key: string, make: () => Store, prefix: StorePrefix): FailoverStore {
  g.__rekindleFailover ??= new Map();
  let f = g.__rekindleFailover.get(key);
  if (!f) {
    f = new FailoverStore(make(), memoryFor(prefix));
    g.__rekindleFailover.set(key, f);
  }
  return f;
}

/** Is any store on this instance in safe mode right now? (the Workbench banner, the x-store-degraded header) */
export const storeDegraded = (): boolean => [...(g.__rekindleFailover?.values() ?? [])].some((f) => f.degraded());

/** tests: forget every circuit */
export const resetFailover = () => g.__rekindleFailover?.clear();

/**
 * Redis when configured (KV_REST_API_* or UPSTASH_REDIS_REST_*, unless STORE_BACKEND=blob), else Blob when
 * BLOB_READ_WRITE_TOKEN is set, each behind a FailoverStore; else in-memory, which is refused on a Vercel deployment.
 */
export function storeFromEnv(env: Record<string, string | undefined> = process.env, prefix: StorePrefix = ""): Store {
  const fault = storeFaultInjected(env);
  const redis = redisFromEnv(env);
  const token = env.BLOB_READ_WRITE_TOKEN;
  if (redis) {
    const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
    return failover(`redis|${fault}|${url}|${envKeyPrefix(env)}|${prefix}`, () => (fault ? new UnavailableStore("redis") : new RedisStore(redis, prefix, envKeyPrefix(env))), prefix);
  }
  if (token) return failover(`blob|${fault}|${token}|${prefix}`, () => (fault ? new UnavailableStore("blob") : new BlobStore(token, prefix)), prefix);
  if (env.VERCEL) throw new Error("no store on this deployment (KV_REST_API_URL + KV_REST_API_TOKEN, or BLOB_READ_WRITE_TOKEN); refusing the in-memory store");
  if (fault) return failover(`memory|fault|${prefix}`, () => new UnavailableStore("memory"), prefix);
  return memoryFor(prefix);
}
