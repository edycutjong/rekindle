import { describe, expect, it } from "vitest";
import robots from "../app/robots";

const list = (v: string | string[] | undefined) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/** an older first-match parser: Allow lines then Disallow lines in emitted order, first prefix match wins, default allow */
function firstMatch(allow: string[], disallow: string[], path: string): boolean {
  for (const [rule, ok] of [...allow.map((a) => [a, true] as const), ...disallow.map((d) => [d, false] as const)]) if (path.startsWith(rule)) return ok;
  return true;
}

describe("robots.txt (app/robots.ts)", () => {
  it("QA round 4 (a2a r02): crawlers keep the landing pages and stay off every Blob-backed per-id URL", () => {
    const r = robots();
    const rule = Array.isArray(r.rules) ? r.rules[0] : r.rules;
    expect(rule.userAgent).toBe("*");
    expect(list(rule.disallow)).toEqual(["/plans/", "/cases/", "/api/", "/integrations/qloo?"]);
  });

  it("QA round 4 (a2a r03): no root Allow, so first-match parsers honour the disallows too", () => {
    const r = robots();
    const rule = Array.isArray(r.rules) ? r.rules[0] : r.rules;
    const allow = list(rule.allow);
    const disallow = list(rule.disallow);
    expect(allow).not.toContain("/");
    for (const p of ["/plans/0b6f1c2e-0000-4000-8000-000000000000", "/api/plans/x?calls=1", "/integrations/qloo?plan=x", "/cases/abc"]) expect(firstMatch(allow, disallow, p)).toBe(false);
    for (const p of ["/", "/judge", "/cases/new", "/integrations/qloo"]) expect(firstMatch(allow, disallow, p)).toBe(true);
  });
});
