/**
 * Receipts for /integrations/qloo (build-plan D5): the Qloo requests behind the most recent plans, read from the stored
 * call logs (path, params, status, ms, result count — never the key, I5). Aggregates are computed here from those
 * logs, so every number on the page comes from a stored call.
 */
import type { PlanDoc, QlooCallsDoc, Store } from "./store";

export interface PlanReceipt {
  plan: Pick<PlanDoc, "id" | "case_id" | "week" | "created_at" | "llm_provider" | "llm_model" | "latency_ms" | "origin"> & { cards: number; refusals: number };
  calls: QlooCallsDoc["calls"];
}

export interface Receipts {
  plans: PlanReceipt[];
  totals: { calls: number; non200: number; endpoints: string[]; params: string[]; p50: number | null; p95: number | null };
}

/** parameters that carry product meaning; transport-only keys are not counted as depth */
const NOT_PRODUCT = new Set(["take", "page", "offset"]);

export function percentile(xs: number[], p: number): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
}

export function summarise(plans: PlanReceipt[]): Receipts["totals"] {
  const all = plans.flatMap((p) => p.calls);
  const endpoints = [...new Set(all.map((c) => c.path))].sort();
  const params = [...new Set(all.flatMap((c) => Object.keys(c.params_json)).filter((k) => !NOT_PRODUCT.has(k)))].sort();
  const ms = all.map((c) => c.ms);
  return { calls: all.length, non200: all.filter((c) => c.status !== 200).length, endpoints, params, p50: percentile(ms, 50), p95: percentile(ms, 95) };
}

let cache: { at: number; key: string; r: Receipts } | null = null;

export async function latestReceipts(store: Store, o: { limit?: number; planId?: string | null } = {}, now = Date.now()): Promise<Receipts> {
  const limit = o.limit ?? 5;
  const key = `${o.planId ?? ""}|${limit}`;
  if (cache && cache.key === key && now - cache.at < 20_000) return cache.r;
  const ids = o.planId ? [o.planId] : await store.listPlanIds(limit);
  const plans: PlanReceipt[] = [];
  for (const id of ids) {
    const [plan, calls] = await Promise.all([store.getPlan(id), store.getCalls(id)]);
    // the injected-outage demo sends no request; it is not a receipt of Qloo's behaviour
    if (!plan || plan.fault) continue;
    plans.push({
      plan: { id: plan.id, case_id: plan.case_id, week: plan.week, created_at: plan.created_at, llm_provider: plan.llm_provider, llm_model: plan.llm_model, latency_ms: plan.latency_ms, origin: plan.origin, cards: plan.cards.length, refusals: plan.refusals.length },
      calls: calls?.calls ?? [],
    });
  }
  const r = { plans, totals: summarise(plans) };
  cache = { at: now, key, r };
  return r;
}
