/**
 * Server-side orchestration shared by the API routes and scripts: seeded-case cloning, intake, and running the agent
 * for a stored case with its Qloo call log persisted beside the plan.
 */
import profiles from "../fixtures/profiles.json";
import { runAgent, type AgentEvent } from "./agent";
import { llmChainFromEnv, type LlmHandle } from "./llm";
import { qlooFromEnv, type QlooCallLog, type QlooClient } from "./qloo";
import { EMPTY_HISTORY, wkt } from "./plan";
import { callsDoc, CaseDoc, caseRowFromDoc, newId, planDocFromAgent, type PlanDoc, type Store } from "./store";

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

export class NotFound extends Error {
  constructor(m: string) {
    super(m);
    this.name = "NotFound";
  }
}
