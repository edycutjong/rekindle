import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { receiptsPaused, RECEIPTS_PAUSED_NOTE } from "../lib/receipts-cached";
import { ARM_LABEL, benchReceipt, benchRows, loadJudgeData, oracleOverFlag, pctLabel, profilesWith, REPO_CLOSED_NOTE, repoPublic, type AuditResults, type BenchResults } from "../lib/judge";
import { countRules, summarise } from "../lib/receipts";

const arm = (o: Partial<BenchResults["arms"][string]> = {}) => ({ outing_venues: 10, errors: 0, violation: 3, violation_rate: 0.3, unverifiable: 2, closed_at_slot: 1, alcohol: 0, alcohol_denominator: 5, unknown_hours: 1, ...o });
const bench = {
  generated_by: "scripts/bench.py",
  finished_at: "2026-10-07T13:00:00+00:00",
  base: "https://x",
  model_arm_a: "m",
  profiles: 20,
  in_recovery_profiles: 10,
  definitions: { killer_number: "k", unverifiable: "u", oracle: "o", ablation_pool: "p" },
  arms: { B: arm({ violation: 0, violation_rate: 0 }), A: arm(), "B-4": arm({ alcohol: 4 }) },
  ablation_in_recovery: {},
  latency: {},
  coverage_refusals_arm_b: [{ profile: "cal", empty_outings: [{ day: "sunday", rung: "social", reason: "none" }] }],
  plans: [
    { profile: "maya", arm: "B", review: 1, refusals_by_rule: {} },
    { profile: "ruby", arm: "B-", review: 2, refusals_by_rule: {} },
    { profile: "theo", arm: "B", review: 0, refusals_by_rule: {} },
  ],
  errors: [],
} satisfies BenchResults;

describe("/judge view model", () => {
  it("orders arms A first and puts the manual-audit rate beside the Qloo-graded one", () => {
    const audit: AuditResults = { generated_by: "scripts/manual_audit.py", finished_at: "t", auditor: "a", method: "m", arms: { A: { sampled: 20, checked: 18, inconclusive: 2, violations: 9, rate: 0.5, not_found: 4, closed_at_slot: 5, alcohol: 0 } } };
    const rows = benchRows(bench, audit);
    expect(rows.map((x) => x.arm)).toEqual(["A", "B", "B-4"]);
    expect(rows[0]).toMatchObject({ rate: "30.0%", violations: 3, alcohol: "0 / 5", audited: "50.0% (9/18, 2 inconclusive)" });
    expect(rows[1]!.audited).toBe("not audited yet");
    expect(rows[2]!.audited).toBe("—");
    expect(benchRows(bench, null)[0]!.audited).toBe("not audited yet");
  });
  it("finds the profiles that showed REVIEW / coverage in arm B only", () => {
    expect(profilesWith(bench, "review")).toEqual(["maya"]);
    expect(profilesWith(bench, "coverage")).toEqual(["cal"]);
    expect(profilesWith(null, "review")).toEqual([]);
  });
  it("states the run receipt from the bench's own fields and leaves out what the run did not record", () => {
    expect(benchReceipt(bench)).toBe("bench run finished 2026-10-07 13:00 UTC · 3 Rekindle plans · 0 errors");
    const full = { ...bench, wall_seconds: 822.8, verify_venue_calls: 7, arm_a_runs: [{}, {}], plans: bench.plans.map((x, i) => ({ ...x, qloo_calls: i + 1 })) };
    expect(benchReceipt(full)).toBe("bench run finished 2026-10-07 13:00 UTC · 822.8 s wall clock · 3 Rekindle plans + 2 arm-A model plans · 6 Qloo calls on the plan path · 7 grading calls · 0 errors");
  });
  it("formats rates and never invents one", () => {
    expect(pctLabel(0)).toBe("0.0%");
    expect(pctLabel(null)).toBe("—");
    expect(pctLabel(undefined)).toBe("—");
  });
  it("loads committed outputs and reports a missing file as null (rendered as not run yet)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "judge-"));
    writeFileSync(path.join(dir, "results.json"), JSON.stringify(bench));
    const d = await loadJudgeData(dir);
    expect(d.bench?.profiles).toBe(20);
    expect(d.replan).toBeNull();
    expect(d.audit).toBeNull();
  });
  it("the committed bench says what it predates and never calls the (non-blind) manual audit blind (QA round 2)", async () => {
    const d = await loadJudgeData();
    expect(d.predates?.commits.length).toBeGreaterThan(0);
    for (const c of d.predates!.commits) expect(Date.parse(c.date)).toBeGreaterThanOrEqual(Date.parse(d.predates!.bench_finished_at.slice(0, 10)));
    expect(JSON.stringify(d.bench!.definitions)).not.toMatch(/blind/i);
  });
  it("counts refusals by rule and totals them across plans", () => {
    expect(countRules([{ rule: "R-ALC" }, { rule: "R-OPEN" }, { rule: "R-ALC" }])).toEqual({ "R-ALC": 2, "R-OPEN": 1 });
    const plan = (rules: Record<string, number>, review: number) => ({
      plan: { id: "p", case_id: "c", week: 1, created_at: "t", llm_provider: null, llm_model: null, latency_ms: 1, origin: "agent" as const, cards: 7, refusals: 3, refusals_by_rule: rules, review },
      calls: [],
    });
    const t = summarise([plan({ "R-ALC": 2 }, 1), plan({ "R-ALC": 1, "R-NEAR": 4 }, 0)]);
    expect(t.refusals_by_rule).toEqual({ "R-ALC": 3, "R-NEAR": 4 });
    expect(t.review).toBe(1);
  });

  it("a2a r11: each /judge arm label names its own arm (the B-sym row read 'B · …')", () => {
    const prefix: Record<string, string> = { A: "A · ", B: "B · ", "B-": "B− · ", "B-4": "B−4 · ", "B-sym": "B-sym · " };
    for (const [k, label] of Object.entries(ARM_LABEL)) expect(label.startsWith(prefix[k]!), `${k}: ${label}`).toBe(true);
  });

  it("a2a r11: totals the agency dial (model-placed and model-coached cards) only over receipts that carry it", () => {
    const plan = (cards: number, routed?: number, coached?: number) => ({
      plan: { id: "p", case_id: "c", week: 1, created_at: "t", llm_provider: null, llm_model: null, latency_ms: 1, origin: "agent" as const, cards, refusals: 0, refusals_by_rule: {}, review: 0, ...(routed !== undefined ? { model_routed: routed, model_coached: coached } : {}) },
      calls: [],
    });
    expect(summarise([plan(7, 7, 7), plan(7, 3, 0), plan(7)]).agency).toEqual({ cards: 14, model_routed: 10, model_coached: 7 });
    expect(summarise([plan(7)]).agency).toEqual({ cards: 0, model_routed: 0, model_coached: 0 });
  });

  it("QA round 4 (a2a r05): /judge states the checker's over-flag from oracle_vs_hand, and says nothing when there is none", () => {
    const base = { generated_by: "x", finished_at: "x", auditor: "x", method: "x", arms: {} } as AuditResults;
    expect(oracleOverFlag({ ...base, oracle_vs_hand: { A: { unverifiable: { ok: 4, wrong: 3, inconclusive: 3 } } } })).toMatch(/4 of the 10 LLM venues the automated checker could not match were real and open/);
    expect(oracleOverFlag({ ...base, oracle_vs_hand: { A: { unverifiable: { ok: 0, wrong: 2, inconclusive: 0 } } } })).toBeNull();
    expect(oracleOverFlag(null)).toBeNull();
  });

  it("QA round 6, a2a r09: the repository is public, so /judge links into it by default; REPO_PUBLIC=0 names its files, marked public at submission", () => {
    expect(repoPublic({ REPO_PUBLIC: "1" })).toBe(true);
    expect(repoPublic({})).toBe(true);
    expect(repoPublic({ REPO_PUBLIC: "0" })).toBe(false);
    expect(REPO_CLOSED_NOTE).toBe("public at submission");
  });

  it("QA round 4 (a2a r06): RECEIPTS_PAUSED=1 pauses the latest-plans list() and the page says so in plain words", () => {
    expect(receiptsPaused({ RECEIPTS_PAUSED: "1" })).toBe(true);
    expect(receiptsPaused({})).toBe(false);
    expect(RECEIPTS_PAUSED_NOTE).toMatch(/paused to protect this deployment's storage budget/);
  });
});
