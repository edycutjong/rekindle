/**
 * Receipts for /integrations/qloo: the Qloo requests behind the most recent plans, read from the stored
 * call logs (path, params, status, ms, result count — never the key, I5). Aggregates are computed here from those
 * logs, so every number on the page comes from a stored call.
 */
import type { PlanDoc, QlooCallsDoc, Store } from "./store";
import { realRefusals, routingLabel } from "./view";

export interface PlanReceipt {
  plan: Pick<PlanDoc, "id" | "case_id" | "week" | "created_at" | "llm_provider" | "llm_model" | "latency_ms" | "origin"> & { cards: number; refusals: number; refusals_by_rule: Record<string, number>; review: number; /** lib/view.ts routingLabel (absent in receipts cached before 2026-10-09) */ routing?: string };
  calls: QlooCallsDoc["calls"];
}

export interface Receipts {
  plans: PlanReceipt[];
  totals: { calls: number; non200: number; endpoints: string[]; params: string[]; p50: number | null; p95: number | null; refusals_by_rule: Record<string, number>; review: number };
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
  const refusals_by_rule: Record<string, number> = {};
  for (const p of plans) for (const [k, v] of Object.entries(p.plan.refusals_by_rule ?? {})) refusals_by_rule[k] = (refusals_by_rule[k] ?? 0) + v;
  const review = plans.reduce((n, p) => n + (p.plan.review ?? 0), 0);
  return { calls: all.length, non200: all.filter((c) => c.status !== 200).length, endpoints, params, p50: percentile(ms, 50), p95: percentile(ms, 95), refusals_by_rule, review };
}

/**
 * a2a r02: one entry per key. A single shared slot let every `?plan=` view evict the "latest" entry that /judge and
 * /integrations/qloo share, so the next /judge view paid a Blob list() — an ADVANCED op, of 2,000 a month on Hobby —
 * plus up to 20 reads. Bounded so distinct `?plan=` ids cannot grow it without limit.
 */
const cache = new Map<string, { at: number; r: Receipts }>();
const CACHE_MAX = 32;
/** tests: the cache is module state */
export const resetReceiptsCache = () => {
  cache.clear();
};

/**
 * One strike per (day, venue, rule). The social fallback ladder and the narrow → wide retry can refuse the same venue
 * more than once in a run; the sheet shows it once (lib/view.ts strikesByDay), so the receipts count it once too.
 */
export function distinctRefusals<R extends Pick<PlanDoc["refusals"][number], "rule" | "qloo_entity_id" | "day_name">>(rs: readonly R[]): R[] {
  const seen = new Set<string>();
  return rs.filter((r) => {
    const k = `${r.day_name}|${r.qloo_entity_id}|${r.rule}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export async function latestReceipts(store: Store, o: { limit?: number; planId?: string | null } = {}, now = Date.now()): Promise<Receipts> {
  const limit = o.limit ?? 5;
  const key = `${o.planId ?? ""}|${limit}`;
  const hit = cache.get(key);
  if (hit && now >= hit.at && now - hit.at < 20_000) return hit.r;
  // over-read: weeks a constraint toggle replaced are skipped in the list (their newer version carries their calls too)
  const ids = o.planId ? [o.planId] : await store.listPlanIds(limit * 4);
  const plans: PlanReceipt[] = [];
  for (const id of ids) {
    if (plans.length >= limit) break;
    const [plan, calls] = await Promise.all([store.getPlan(id), store.getCalls(id)]);
    // the injected-outage demo sends no request; it is not a receipt of Qloo's behaviour
    if (!plan || plan.fault) continue;
    if (!o.planId && plan.superseded_by) continue;
    const refusals = distinctRefusals(realRefusals(plan.refusals, plan.cards));
    plans.push({
      plan: { id: plan.id, case_id: plan.case_id, week: plan.week, created_at: plan.created_at, llm_provider: plan.llm_provider, llm_model: plan.llm_model, routing: routingLabel(plan), latency_ms: plan.latency_ms, origin: plan.origin, cards: plan.cards.length, refusals: new Set(refusals.map((x) => `${x.day_name}|${x.qloo_entity_id}`)).size, refusals_by_rule: countRules(refusals), review: plan.review.length },
      calls: calls?.calls ?? [],
    });
  }
  const r = { plans, totals: summarise(plans) };
  cache.delete(key);
  cache.set(key, { at: now, r });
  for (const k of cache.keys()) {
    if (cache.size <= CACHE_MAX) break;
    cache.delete(k); // oldest first (Map keeps insertion order)
  }
  return r;
}

/** refusals grouped by the rule recorded on each strike (verifier rules and the clinician's swap/remove) */
export function countRules(refusals: Pick<PlanDoc["refusals"][number], "rule">[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of refusals) out[r.rule] = (out[r.rule] ?? 0) + 1;
  return out;
}
