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
  plans: { profile: string; arm: string; review: number; refusals_by_rule: Record<string, number>; qloo_calls?: number }[];
  errors: unknown[];
  started_at?: string;
  wall_seconds?: number;
  verify_venue_calls?: number;
  arm_a_runs?: unknown[];
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
  /** a2a r05: the automated checker's grade vs the hand verdict on the same sampled venue, per arm */
  oracle_vs_hand?: Record<string, Record<string, { ok: number; wrong: number; inconclusive: number }>>;
}

/** One sentence from oracle_vs_hand: how often the checker's "unverifiable" was a real, open place in the hand sample. */
export function oracleOverFlag(audit: AuditResults | null): string | null {
  const cell = audit?.oracle_vs_hand?.A?.unverifiable;
  if (!cell || !cell.ok) return null;
  const n = cell.ok + cell.wrong + cell.inconclusive;
  return `In the same random sample, ${cell.ok} of the ${n} LLM venues the automated checker could not match were real and open (it matches by street address, which misses large venues such as parks), so the hand check is the headline.`;
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
  /** cards whose top rated input outweighs the best original love (margin >= 0) */
  rating_leads_loves: number;
  threaded: number;
  tied: number;
  threaded_with_co_inputs: number;
  /** median lead over the best original love (T16 rule), on rating_leads_loves cards */
  margin_median: number | null;
  /** each (rated set, card entity) once: Qloo returns the same week for the same ratings */
  distinct: { cards: number; rating_sets: number; rating_leads_loves: number; threaded: number; previous_rule_threaded: number };
  /** the rule before T16 (lead over the next input of any kind), on the same cards */
  previous_rule: { rekindled_top: number; threaded: number; margin_median: number | null };
  /** bench/replan.json's new cards measured by the same margin */
  bench: { source: string; finished_at: string | null; new_cards: number | null; cards_with_margin: number; threaded: number; margin_median: number | null } | null;
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
  "B-": "B− · screen off, 14-tag exclusion kept",
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
  /** manual-audit rate for this arm (not blind), or a reason it has none */
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

/**
 * The GitHub repository is public (since 2026-10-17), so /judge links into its files by default, including a local
 * `npm run dev` with no REPO_PUBLIC set (a2a r09: the default used to be closed). REPO_PUBLIC=0 restores the plain-text
 * names marked "(public at submission)", which are only right for a private repository: a link that 404s for everyone
 * without access is worse than no link.
 */
export const REPO = "https://github.com/edycutjong/rekindle";
export const REPO_CLOSED_NOTE = "public at submission";
export const repoPublic = (env: Record<string, string | undefined> = process.env) => env.REPO_PUBLIC !== "0";

/** docs/rigor.json ← scripts/rigor.py: test counts measured from the suite (drift-checked by npm run docs:check) */
export interface Rigor {
  tests: number;
  files: number;
  property_cases: number;
  properties: number;
  runs_per_property: number;
}

/**
 * One-line run receipt for /judge, from the bench's own fields (the same facts bench_table.py writes into DEMO.md).
 * Missing fields are left out, never estimated.
 */
export function benchReceipt(b: BenchResults): string {
  const utc = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;
  const parts: string[] = [`bench run finished ${utc(b.finished_at)}`];
  if (typeof b.wall_seconds === "number") parts.push(`${b.wall_seconds} s wall clock`);
  const armA = b.arm_a_runs ? ` + ${b.arm_a_runs.length} arm-A model plans` : "";
  parts.push(`${b.plans.length} Rekindle plans${armA}`);
  if (b.plans.every((x) => typeof x.qloo_calls === "number")) {
    parts.push(`${b.plans.reduce((n, x) => n + (x.qloo_calls ?? 0), 0)} Qloo calls on the plan path`);
  }
  if (typeof b.verify_venue_calls === "number") parts.push(`${b.verify_venue_calls} grading calls`);
  parts.push(`${b.errors.length} errors`);
  return parts.join(" · ");
}
