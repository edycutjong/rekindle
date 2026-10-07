/**
 * Server-side orchestration shared by the API routes and scripts: seeded-case cloning, intake, and running the agent
 * for a stored case with its Qloo call log persisted beside the plan.
 */
import profiles from "../fixtures/profiles.json";
import { runAgent, templateCoaching, type AgentEvent } from "./agent";
import { llmChainFromEnv, type LlmHandle } from "./llm";
import { qlooFromEnv, type QlooCallLog, type QlooClient } from "./qloo";
import { applyConstraints, EMPTY_HISTORY, wkt } from "./plan";
import { diffWeeks } from "./replan";
import { callsDoc, CaseDoc, caseRowFromDoc, newId, PlanDoc, planDocFromAgent, planDocFromToggle, weekPlanFromDoc, type Store } from "./store";

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
}

/** Run week 1 for a stored case, persist the plan and its Qloo call log, and return the stored plan. */
export async function runPlanForCase(o: RunPlanOptions): Promise<PlanDoc> {
  const c = await o.store.getCase(o.caseId);
  if (!c) throw new NotFound(`case ${o.caseId} not found`);
  const calls: QlooCallLog[] = [];
  const onCall = (l: QlooCallLog) => {
    calls.push(l);
    o.onEvent?.({ type: "qloo", path: l.path, status: l.status, ms: l.ms, n_results: l.n_results, params: l.params });
  };
  const qloo = (o.qloo ?? qlooFromEnv)(onCall);
  const llms = o.llms ?? llmChainFromEnv();
  const plan = await runAgent({ qloo, case: caseRowFromDoc(c), week: 1, history: EMPTY_HISTORY, llms, onEvent: (e) => e.type !== "plan" && o.onEvent?.(e) });
  const doc = planDocFromAgent(plan, { caseId: c.id, history: EMPTY_HISTORY, calls: calls.length });
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
 * Loosening a constraint keeps the verified week as it is (nothing fails); re-plan to use the wider constraint.
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
  const w = await applyConstraints(qloo, weekPlanFromDoc(parent), caseRowFromDoc(next), parent.history);
  const prior = (await o.store.getCalls(parent.id))?.calls ?? [];
  const doc = await refreshDiff(o.store, planDocFromToggle(parent, w, { caseId: next.id, changed, struck: w.struck.length, refilled: w.refilled, ms: Date.now() - t0, calls: prior.length + calls.length, coach: (card) => templateCoaching(card) }));
  await o.store.putCase(next);
  await o.store.putPlan(doc);
  const merged = callsDoc(doc.id, calls);
  await o.store.putCalls({ plan_id: doc.id, calls: [...prior, ...merged.calls] });
  return { plan: doc, case: next };
}

/** Recompute a re-planned week's diff after its cards changed (clinician swap / remove, constraint toggle). */
export async function refreshDiff(store: Store, plan: PlanDoc): Promise<PlanDoc> {
  if (!plan.diff) return plan;
  const from = await store.getPlan(plan.diff.from_plan_id);
  if (!from) return plan;
  const d = diffWeeks(weekPlanFromDoc(from), weekPlanFromDoc(plan), plan.history);
  return PlanDoc.parse({ ...plan, diff: { from_plan_id: from.id, ...d } });
}

export class NotFound extends Error {
  constructor(m: string) {
    super(m);
    this.name = "NotFound";
  }
}
