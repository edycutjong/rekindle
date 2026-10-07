/**
 * Server-side orchestration shared by the API routes and scripts: seeded-case cloning, intake, and running the agent
 * for a stored case with its Qloo call log persisted beside the plan.
 */
import profiles from "../fixtures/profiles.json";
import { coachingAlcohol, runAgent, templateCoaching, type AgentEvent } from "./agent";
import { llmChainFromEnv, type LlmHandle } from "./llm";
import { QlooClient, qlooFromEnv, type QlooCallLog } from "./qloo";
import { applyConstraints, EMPTY_HISTORY, wkt } from "./plan";
import { ALCOHOL_EXCLUDE_4, ALCOHOL_EXCLUDE_14 } from "./tags";
import { alcoholScreen } from "./verify";
import { diffWeeks } from "./replan";
import { callsDoc, cardFromDoc, CaseDoc, caseRowFromDoc, newId, PlanDoc, planDocFromAgent, planDocFromToggle, weekPlanFromDoc, type RunDoc, type Store } from "./store";

export interface SeedProfile {
  slug: string;
  label: string;
  locality: string;
  lon: number;
  lat: number;
  radius_m: number;
  energy: 1 | 2 | 3;
  price_max: number;
  in_recovery: boolean;
  need_quiet: boolean;
  need_wheelchair: boolean;
  loves: { text: string; qloo_id: string; qloo_kind: "entity" | "tag"; entity_type?: string; name?: string }[];
}

export const SEEDS = (profiles as { profiles: SeedProfile[] }).profiles;

/** Clone a fictional seeded profile into a fresh case for this visitor. Inputs only; the plan is always run live. */
export function caseFromSeed(slug: string): CaseDoc | null {
  const p = SEEDS.find((s) => s.slug === slug);
  if (!p) return null;
  return CaseDoc.parse({
    id: newId(),
    label: p.label,
    created_at: new Date().toISOString(),
    point_wkt: wkt(p.lon, p.lat),
    lon: p.lon,
    lat: p.lat,
    locality: p.locality,
    energy: p.energy,
    price_max: p.price_max,
    max_meters: p.radius_m,
    in_recovery: p.in_recovery,
    need_quiet: p.need_quiet,
    need_wheelchair: p.need_wheelchair,
    is_seed: true,
    seed_slug: p.slug,
    loves: p.loves.map((l) => ({ id: newId(), weight: 1, ...l })),
  });
}

export interface RunPlanOptions {
  store: Store;
  caseId: string;
  onEvent?: (e: AgentEvent | { type: "qloo"; path: string; status: number; ms: number; n_results: number; params: Record<string, string> }) => void;
  /** injectable for scripts/tests; default: from env */
  qloo?: (onCall: (l: QlooCallLog) => void) => QlooClient;
  llms?: LlmHandle[];
  /** bench namespace only (the route refuses it otherwise): ablation arm + verifier-input pool audit */
  bench?: BenchArm;
  /** injected failure for the Qloo-unavailable demo: no request leaves the server */
  fault?: "qloo_unreachable";
}

export type BenchArm = "B" | "B-" | "B-4";

/** Arm → tool options (complexity.md §2): B− turns R-ALC's screen off, B−4 also sends only the 4 bar tags. */
export function benchToolOptions(arm: BenchArm) {
  return { alcoholScreen: arm === "B", excludeTagSet: arm === "B-4" ? ALCOHOL_EXCLUDE_4 : ALCOHOL_EXCLUDE_14 };
}

/** A Qloo client whose every request fails as a network error before leaving the server (the outage demo). */
export function unreachableQloo(onCall: (l: QlooCallLog) => void): QlooClient {
  return new QlooClient({
    apiKey: "fault-injection-no-key",
    onCall,
    sleep: async () => {},
    fetchImpl: async () => {
      throw new TypeError("fetch failed (injected outage: no request was sent)");
    },
  });
}

/** A "running" marker older than this is treated as dead (the route's maxDuration is 60 s). */
export const RUN_STALE_MS = 90_000;

/**
 * Week 1 already exists or is being made for this case? (QA round 1: a reload mid-stream, or reopening /cases/<id>,
 * started a second full agent run.) `plan`: return it, no new run. `running`: a fresh run is in flight.
 */
export async function planRunState(store: Store, caseId: string, now = Date.now()): Promise<{ plan: PlanDoc } | { running: RunDoc } | null> {
  const run = await store.getRun(caseId).catch(() => null);
  if (!run) return null;
  if (run.status === "done" && run.plan_id) {
    const plan = await store.getPlan(run.plan_id).catch(() => null);
    return plan ? { plan } : null;
  }
  if (run.status === "running" && now - Date.parse(run.started_at) < RUN_STALE_MS) return { running: run };
  return null;
}

/** Run week 1 for a stored case, persist the plan and its Qloo call log, and return the stored plan. */
export async function runPlanForCase(o: RunPlanOptions): Promise<PlanDoc> {
  const c = await o.store.getCase(o.caseId);
  if (!c) throw new NotFound(`case ${o.caseId} not found`);
  const startedAt = new Date().toISOString();
  const mark = (status: RunDoc["status"], planId: string | null = null) => o.store.putRun({ case_id: c.id, status, plan_id: planId, started_at: startedAt, updated_at: new Date().toISOString() });
  await mark("running");
  try {
    const doc = await runWeekOne(o, c);
    await mark("done", doc.id);
    return doc;
  } catch (e) {
    await mark("failed").catch(() => {});
    throw e;
  }
}

async function runWeekOne(o: RunPlanOptions, c: CaseDoc): Promise<PlanDoc> {
  const calls: QlooCallLog[] = [];
  const onCall = (l: QlooCallLog) => {
    calls.push(l);
    o.onEvent?.({ type: "qloo", path: l.path, status: l.status, ms: l.ms, n_results: l.n_results, params: l.params });
  };
  const qloo = (o.fault ? unreachableQloo : (o.qloo ?? qlooFromEnv))(onCall);
  // the outage demo routes deterministically: no LLM spend for a week that cannot get any Qloo data
  const llms = o.fault ? [] : (o.llms ?? llmChainFromEnv());
  const pool = new Map<string, { entity_id: string; name: string; verdict: "REFUSE" | "REVIEW"; hits: string[] }>();
  let pools = 0;
  const seenPool = new Set<string>();
  const toolOptions = o.bench
    ? {
        ...benchToolOptions(o.bench),
        onPool: (p: { entities: { entity_id: string; name: string; tags?: { id?: string; tag_id?: string }[] }[] }) => {
          pools++;
          for (const e of p.entities) {
            seenPool.add(e.entity_id);
            if (pool.has(e.entity_id)) continue;
            const a = alcoholScreen(e);
            if (a.verdict !== "PASS") pool.set(e.entity_id, { entity_id: e.entity_id, name: e.name, verdict: a.verdict, hits: a.hits.map((h) => h.value.replace("urn:tag:", "")) });
          }
        },
      }
    : undefined;
  const row = caseRowFromDoc(c);
  const plan = await runAgent({ qloo, case: row, week: 1, history: EMPTY_HISTORY, llms, toolOptions, onEvent: (e) => e.type !== "plan" && o.onEvent?.(e) });
  const base = planDocFromAgent(plan, { caseId: c.id, history: EMPTY_HISTORY, calls: calls.length });
  const doc = PlanDoc.parse({
    ...base,
    ...(o.fault ? { fault: o.fault } : {}),
    ...(o.bench ? { bench: { arm: o.bench, alcohol_screen: o.bench === "B", exclude_set: o.bench === "B-4" ? "4" : "14", pools, pool_entities: seenPool.size, pool_alcohol: [...pool.values()] } } : {}),
  });
  await o.store.putPlan(doc);
  await o.store.putCalls(callsDoc(doc.id, calls));
  return doc;
}

/** The constraint tabs (ui.md Case strip). Distance and budget can be tightened or loosened; flags switch on/off. */
export interface ConstraintPatch {
  in_recovery?: boolean;
  need_quiet?: boolean;
  need_wheelchair?: boolean;
  max_meters?: number;
  price_max?: number;
}

export class Conflict extends Error {
  constructor(m: string) {
    super(m);
    this.name = "Conflict";
  }
}

/**
 * Toggle a constraint on a draft week: re-verify only the placed outings against the new case row (lib/plan.ts
 * applyConstraints), strike the ones that now fail in place with their rule, and refill only those slots live.
 * Writes a new case (the old plan stays consistent with its own case) and a new plan whose parent is the old one.
 * Loosening a constraint keeps every verified card and retries only the empty outing slots (coverage refusal → the
 * clinician widens the radius); re-plan to use the wider constraint everywhere.
 */
export async function toggleConstraints(o: { store: Store; planId: string; patch: ConstraintPatch; qloo?: (onCall: (l: QlooCallLog) => void) => QlooClient }): Promise<{ plan: PlanDoc; case: CaseDoc }> {
  const t0 = Date.now();
  const parent = await o.store.getPlan(o.planId);
  if (!parent) throw new NotFound(`plan ${o.planId} not found`);
  if (parent.status !== "draft") throw new Conflict("only a draft week can change constraints");
  const c = await o.store.getCase(parent.case_id);
  if (!c) throw new NotFound(`case ${parent.case_id} not found`);
  const changed = Object.fromEntries(Object.entries(o.patch).filter(([k, v]) => v !== undefined && c[k as keyof CaseDoc] !== v)) as Record<string, boolean | number>;
  if (Object.keys(changed).length === 0) return { plan: parent, case: c };
  const next = CaseDoc.parse({ ...c, ...changed, id: newId(), created_at: new Date().toISOString() });
  const calls: QlooCallLog[] = [];
  const qloo = (o.qloo ?? qlooFromEnv)((l) => calls.push(l));
  const w = await applyConstraints(qloo, weekPlanFromDoc(parent), caseRowFromDoc(next), parent.history, { refillEmpty: loosens(c, next) });
  const prior = (await o.store.getCalls(parent.id))?.calls ?? [];
  const toggled = planDocFromToggle(parent, w, { caseId: next.id, changed, struck: w.struck.length, refilled: w.refilled, ms: Date.now() - t0, calls: prior.length + calls.length, coach: (card) => templateCoaching(card) });
  const doc = await refreshDiff(o.store, next.in_recovery ? screenCoaching(toggled) : toggled);
  await o.store.putCase(next);
  await o.store.putPlan(doc);
  const merged = callsDoc(doc.id, calls);
  await o.store.putCalls({ plan_id: doc.id, calls: [...prior, ...merged.calls] });
  return { plan: doc, case: next };
}

/**
 * COACH-ALC over a whole week (home cards too): every coaching line that mentions drinking is replaced by the template
 * dose and logged as a truth-boundary drop. Run when a case is in recovery after a constraint toggle, because the lines
 * were written before the flag was set (the model never sees the flag).
 */
export function screenCoaching(plan: PlanDoc): PlanDoc {
  const dropped: PlanDoc["dropped"] = [];
  const cards = plan.cards.map((c) => {
    const hit = coachingAlcohol(c.coaching, c.name);
    if (!hit) return c;
    dropped.push({ rule: "COACH-ALC", entity_id: c.qloo_entity_id, detail: `coaching line mentions drinking ("${hit}"); replaced by the template dose` });
    return { ...c, coaching: templateCoaching(cardFromDoc(c), c.home_type), coaching_by: "template" as const };
  });
  return dropped.length ? PlanDoc.parse({ ...plan, cards, dropped: [...plan.dropped, ...dropped] }) : plan;
}

/** Did the change loosen any constraint (wider radius, higher budget, a flag switched off)? Then empty outings are retried. */
export function loosens(before: CaseDoc, after: CaseDoc): boolean {
  return after.max_meters > before.max_meters || after.price_max > before.price_max || (before.in_recovery && !after.in_recovery) || (before.need_quiet && !after.need_quiet) || (before.need_wheelchair && !after.need_wheelchair);
}

/** Recompute a re-planned week's diff after its cards changed (clinician swap / remove, constraint toggle). */
export async function refreshDiff(store: Store, plan: PlanDoc): Promise<PlanDoc> {
  if (!plan.diff) return plan;
  const from = await store.getPlan(plan.diff.from_plan_id);
  if (!from) return plan;
  const d = diffWeeks(weekPlanFromDoc(from), weekPlanFromDoc(plan), plan.history, plan.diff.kept_check);
  return PlanDoc.parse({ ...plan, diff: { from_plan_id: from.id, kept_check: plan.diff.kept_check, ...d } });
}

export class NotFound extends Error {
  constructor(m: string) {
    super(m);
    this.name = "NotFound";
  }
}
