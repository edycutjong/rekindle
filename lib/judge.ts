/**
 * /judge view model: the bench table, ablation, re-plan responsiveness and the manual audit,
 * read from the committed files that scripts produce (bench/results.json ← scripts/bench.py, bench/replan.json ←
 * scripts/replan_check.py, bench/audit.json ← scripts/manual_audit.py). Nothing here computes a new claim: rates are
 * the scripts' own fields, formatted. A missing file renders as "not run yet", never as a number.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

export interface ArmSummary {
  outing_venues: number;
  errors: number;
  violation: number;
  violation_rate: number | null;
  unverifiable: number;
  closed_at_slot: number;
  alcohol: number;
  alcohol_denominator: number;
  unknown_hours: number;
  alcohol_review?: number;
  beyond_radius?: number;
}

export interface AblationArm {
  profiles: number;
  pool_candidates: number;
  pool_alcohol: number;
  pool_alcohol_rate: number | null;
  profiles_with_pool_alcohol: number;
  outing_cards: number;
  plan_alcohol_leak: number;
  plan_alcohol_leak_rate: number | null;
  profiles_with_plan_leak: number;
}

export interface BenchResults {
  generated_by: string;
  finished_at: string;
  base: string;
  model_arm_a: string;
  profiles: number;
  in_recovery_profiles: number;
  definitions: Record<string, string>;
  arms: Record<string, ArmSummary>;
  ablation_in_recovery: Record<string, AblationArm>;
  latency: Record<string, Record<string, number | null>>;
  coverage_refusals_arm_b: { profile: string; empty_outings: { day: string; rung: string; reason: string }[] }[];
  plans: { profile: string; arm: string; review: number; refusals_by_rule: Record<string, number> }[];
  errors: unknown[];
}

export interface ReplanResults {
  generated_by: string;
  finished_at: string;
  N: number;
  passed: number;
  result: string;
  excluded: { profile: string; reason: string }[];
  errors: unknown[];
  low_rated_reappearing: number;
  attributed_new_cards_total: number;
  new_cards_total: number;
  ember_margin_median_of_profiles: number | null;
  replan_seconds_p50: number | null;
  definition: string;
}

export interface AuditArm {
  sampled: number;
  checked: number;
  inconclusive: number;
  violations: number;
  rate: number | null;
  not_found: number;
  closed_at_slot: number;
  alcohol: number;
}

export interface AuditResults {
  generated_by: string;
  finished_at: string;
  auditor: string;
  method: string;
  arms: Record<string, AuditArm>;
}

/** bench/predates.json (scripts/bench_table.py): plan-path commits made after the bench finished */
export interface Predates {
  bench_finished_at: string;
  commits: { commit: string; date: string; subject: string }[];
}

export interface JudgeData {
  bench: BenchResults | null;
  replan: ReplanResults | null;
  audit: AuditResults | null;
  predates: Predates | null;
  emberLive: EmberLive | null;
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/** bench/ember-live.json ← scripts/ember-margins.ts: ember margins measured on this deployment's live re-plans */
export interface EmberLive {
  generated_at: string;
  definition: string;
  threshold: number;
  replans: number;
  new_cards_naming_a_rating: number;
  rekindled_top: number;
  threaded: number;
  tied: number;
  margin_median: number | null;
  margin_over_original_loves_median: number | null;
}

export async function loadJudgeData(dir = path.join(process.cwd(), "bench")): Promise<JudgeData> {
  const [bench, replan, audit, predates, emberLive] = await Promise.all([
    readJson<BenchResults>(path.join(dir, "results.json")),
    readJson<ReplanResults>(path.join(dir, "replan.json")),
    readJson<AuditResults>(path.join(dir, "audit.json")),
    readJson<Predates>(path.join(dir, "predates.json")),
    readJson<EmberLive>(path.join(dir, "ember-live.json")),
  ]);
  return { bench, replan, audit, predates, emberLive };
}

export const ARM_LABEL: Record<string, string> = {
  A: "A · LLM only (same model, asked for named venues)",
  B: "B · Rekindle",
  "B-": "B− · Rekindle, alcohol screen off",
  "B-4": "B−4 · screen off, 4 bar tags only",
  "B-sym": "B · Rekindle cards through arm A's address pipeline",
};

export const pctLabel = (r: number | null | undefined) => (r === null || r === undefined ? "—" : `${(r * 100).toFixed(1)}%`);

export interface BenchRow {
  arm: string;
  label: string;
  venues: number;
  violations: number;
  rate: string;
  unverifiable: number;
  closed: number;
  alcohol: string;
  unknownHours: number;
  /** blind-audit rate for this arm, or a reason it has none */
  audited: string;
}

/** The killer-number table: one row per arm, Qloo-graded and (where audited) the manual-audit rate beside it. */
export function benchRows(bench: BenchResults, audit: AuditResults | null): BenchRow[] {
  const order = ["A", "B", "B-sym", "B-", "B-4"].filter((a) => bench.arms[a]);
  return order.map((arm) => {
    const s = bench.arms[arm]!;
    const au = audit?.arms[arm];
    return {
      arm,
      label: ARM_LABEL[arm] ?? arm,
      venues: s.outing_venues,
      violations: s.violation,
      rate: pctLabel(s.violation_rate),
      unverifiable: s.unverifiable,
      closed: s.closed_at_slot,
      alcohol: `${s.alcohol} / ${s.alcohol_denominator}`,
      unknownHours: s.unknown_hours,
      audited: au ? `${pctLabel(au.rate)} (${au.violations}/${au.checked}${au.inconclusive ? `, ${au.inconclusive} inconclusive` : ""})` : arm === "A" || arm === "B" ? "not audited yet" : "—",
    };
  });
}

/** Seeded profiles whose arm-B plan showed a given edge state in the committed bench run (links on /judge). */
export function profilesWith(bench: BenchResults | null, what: "review" | "coverage"): string[] {
  if (!bench) return [];
  if (what === "coverage") return bench.coverage_refusals_arm_b.map((x) => x.profile);
  return bench.plans.filter((p) => p.arm === "B" && p.review > 0).map((p) => p.profile);
}
