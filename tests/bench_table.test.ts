import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

/** runs scripts/bench_table.py's killer() and devpost_bullets() on synthetic results (no bench files touched) */
function render(n: number): string {
  const arm = (v: number, total: number) => ({ violation: v, outing_venues: total, unverifiable: v, closed_at_slot: n, alcohol: n, violation_rate: total ? v / total : 0 });
  const r = { profiles: 1, finished_at: "2026-10-30T12:00:00", arms: { A: arm(n, 1), B: arm(0, 1), "B-sym": arm(n, 1) }, ablation_in_recovery: { B: { profiles: 1, outing_cards: 1, plan_alcohol_leak: 0 }, "B-": { profiles: 1, outing_cards: 1, plan_alcohol_leak: n }, "B-4": { profiles: 1, outing_cards: 1, plan_alcohol_leak: n } } };
  const hand = { sampled: 1, checked: 1, inconclusive: n, violations: n, rate: n, not_found: n, closed_at_slot: n, alcohol: n };
  const au = { auditor: "the build agent (Claude), not blind: test", arms: { A: hand, B: { ...hand, violations: 0, rate: 0 } }, oracle_vs_hand: { A: { unverifiable: { ok: n, wrong: 0, inconclusive: 0 } } } };
  const py = `import json,sys; sys.path.insert(0,'scripts'); import bench_table as t; r,au=json.loads(sys.argv[1]),json.loads(sys.argv[2]); print(t.killer(r,au)); print("\\n".join(t.devpost_bullets(r,au)))`;
  return execFileSync("python3", ["-c", py, JSON.stringify(r), JSON.stringify(au)], { encoding: "utf8" });
}

describe("generated headline copy (scripts/bench_table.py)", () => {
  it("QA round 4 (a2a r05): the headline and Devpost bullets read correctly at 0 and 1 — no 'all 0', '1 don't', '1 are', '1 audited venues'; the auditor is named (B21)", () => {
    for (const n of [0, 1]) {
      const out = render(n);
      expect(out).not.toMatch(/\ball 0\b|\b1 don't\b|\b1 are\b|\b1 audited venues\b|\b1 venues\b|\b1 in-recovery profiles\b/);
      expect(out).toContain("**Asked for named places, the same LLM got");
      // "hand-checked" read as a person; the audit was done by the build agent, an AI, and every line that carries its
      // number says so (QA on the story page, B21); the ablation counts tags and keywords, never "serve alcohol"
      expect(out).not.toMatch(/hand-checked|done by the build agent|cards serve alcohol/);
      expect(out.match(/our build agent \(Claude, an AI; not blind\)/g)?.length).toBe(2);
      expect(out).toContain("outing cards carry an alcohol tag or keyword");
    }
    expect(render(1)).toMatch(/1 of the 1 venue it couldn't match was real and open/);
    expect(render(0)).not.toMatch(/over-flags: in the same random sample/);
  });
});
