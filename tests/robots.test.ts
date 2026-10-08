import { describe, expect, it } from "vitest";
import robots from "../app/robots";

describe("robots.txt (app/robots.ts)", () => {
  it("QA round 4 (a2a r02): crawlers keep the landing pages and stay off every Blob-backed per-id URL", () => {
    const r = robots();
    const rule = Array.isArray(r.rules) ? r.rules[0] : r.rules;
    expect(rule.userAgent).toBe("*");
    expect(rule.allow).toEqual(["/", "/cases/new"]);
    expect(rule.disallow).toEqual(["/plans/", "/cases/", "/api/", "/integrations/qloo?"]);
  });
});
