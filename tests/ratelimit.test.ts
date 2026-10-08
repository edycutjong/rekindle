import { describe, expect, it, vi } from "vitest";
import { classify, clientIp, limitsFromEnv, MemoryDailyCounter, MemoryWindow, RateLimiter, refused, tokenMatches, utcDay } from "../lib/ratelimit";

const JUDGE = "judge-token-0123456789abcdef";
const BENCH = "bench-token-0123456789abcdef";
const env = { JUDGE_TOKEN: JUDGE, BENCH_TOKEN: BENCH, RL_PUBLIC_DAILY_PLANS: "3", RL_PUBLIC_PLANS_PER_IP_HOUR: "2", RL_JUDGE_DAILY_PLANS: "5", RL_BENCH_DAILY_PLANS: "4" };
const req = (h: Record<string, string> = {}) => new Request("http://x/api/cases/x/plan", { method: "POST", headers: h });

describe("rate limiting (lib/ratelimit.ts)", () => {
  it("classifies bench, judge (header or cookie) and public; wrong or short tokens are public", () => {
    expect(classify(req({ "x-bench-token": BENCH }), env)).toBe("bench");
    expect(classify(req({ "x-judge-token": JUDGE }), env)).toBe("judge");
    expect(classify(req({ cookie: `a=1; rk_judge=${JUDGE}` }), env)).toBe("judge");
    expect(classify(req({ "x-judge-token": "nope" }), env)).toBe("public");
    expect(classify(req({ "x-judge-token": "short" }), { JUDGE_TOKEN: "short" })).toBe("public");
    expect(classify(req(), {})).toBe("public");
    expect(tokenMatches(undefined, JUDGE)).toBe(false);
  });

  it("per-IP window: the public plan limit applies per address and resets after the hour", () => {
    const w = new MemoryWindow(1000);
    expect(w.hit("a", 2, 0).ok).toBe(true);
    expect(w.hit("a", 2, 10).ok).toBe(true);
    expect(w.hit("a", 2, 20)).toMatchObject({ ok: false, remaining: 0 });
    expect(w.hit("b", 2, 20).ok).toBe(true);
    expect(w.hit("a", 2, 1001).ok).toBe(true);
    expect(w.hit("x", Infinity).ok).toBe(true);
  });

  it("the public daily cap refuses with a 429 that points at the receipts, never a fake plan", async () => {
    const rl = new RateLimiter(new MemoryDailyCounter(), env);
    const ips = ["1.1.1.1", "2.2.2.2", "3.3.3.3", "4.4.4.4"];
    const out = [];
    for (const ip of ips) out.push(await rl.check(req({ "x-forwarded-for": ip }), "plan"));
    expect(out.map((d) => d.ok)).toEqual([true, true, true, false]);
    expect(out[3]).toMatchObject({ status: 429, reason: "daily", ns: "public" });
    const r = refused(out[3]);
    expect(r.status).toBe(429);
    expect(await r.json()).toMatchObject({ receipts: "/integrations/qloo" });
  });

  it("judges are never counted against the public cap; bench is exempt from the per-IP limit but has its own quota", async () => {
    const counter = new MemoryDailyCounter();
    const rl = new RateLimiter(counter, env);
    for (let i = 0; i < 3; i++) await rl.check(req({ "x-forwarded-for": `9.9.9.${i}` }), "plan");
    expect((await rl.check(req({ "x-forwarded-for": "9.9.9.9" }), "plan")).ok).toBe(false);
    // public is full; the judge still gets through
    const j = await rl.check(req({ "x-forwarded-for": "9.9.9.9", "x-judge-token": JUDGE }), "plan");
    expect(j).toMatchObject({ ok: true, ns: "judge" });
    // bench: same IP, many runs, no per-IP limit, stops at its daily quota (4)
    const b = [];
    for (let i = 0; i < 5; i++) b.push((await rl.check(req({ "x-forwarded-for": "7.7.7.7", "x-bench-token": BENCH }), "plan")).ok);
    expect(b).toEqual([true, true, true, true, false]);
    expect(await counter.get("public", utcDay())).toBe(3);
    expect(await counter.get("judge", utcDay())).toBe(1);
  });

  it("per-IP limit fires before the daily counter; cheap actions never touch the daily counter", async () => {
    const counter = new MemoryDailyCounter();
    const rl = new RateLimiter(counter, env);
    const h = { "x-forwarded-for": "5.5.5.5, 10.0.0.1" };
    expect((await rl.check(req(h), "plan")).ok).toBe(true);
    expect((await rl.check(req(h), "plan")).ok).toBe(true);
    const third = await rl.check(req(h), "plan");
    expect(third).toMatchObject({ ok: false, reason: "ip" });
    expect(third.headers["retry-after"]).toBeDefined();
    expect(await counter.get("public", utcDay())).toBe(2);
    await rl.check(req(h), "resolve");
    expect(await counter.get("public", utcDay())).toBe(2);
    expect(clientIp(req(h))).toBe("5.5.5.5");
  });

  it("defaults: 20 plans/IP/hour and 600/day public", () => {
    const l = limitsFromEnv({});
    expect(l.public.perIpPerHour.plan).toBe(20);
    expect(l.public.dailyPlans).toBe(600);
    expect(l.bench.perIpPerHour.plan).toBe(Infinity);
  });

  it("QA round 4: an unreadable daily counter allows the plan and is never reset to 1", async () => {
    const incr = vi.fn(async () => 1);
    const rl = new RateLimiter({ kind: "blob", get: async () => { throw new Error("Failed to fetch blob: 503"); }, incr }, {});
    const d = await rl.check(req({ "x-forwarded-for": "8.8.8.8" }), "plan");
    expect(d.ok).toBe(true);
    expect(incr).not.toHaveBeenCalled();
  });

  it("QA round 4 (a2a r02): the public plan/case GETs are metered before any Blob read (120/h public, 240 judge, bench unlimited)", async () => {
    const l = limitsFromEnv({});
    expect([l.public.perIpPerHour.read, l.judge.perIpPerHour.read, l.bench.perIpPerHour.read]).toEqual([120, 240, Infinity]);
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
    vi.stubEnv("VERCEL", "");
    const { GET: planGet } = await import("../app/api/plans/[id]/route");
    const { GET: caseGet } = await import("../app/api/cases/[id]/route");
    const id = crypto.randomUUID();
    const get = (ip: string) => planGet(new Request(`http://x/api/plans/${id}`, { headers: { "x-forwarded-for": ip } }), { params: Promise.resolve({ id }) });
    const codes: number[] = [];
    for (let i = 0; i < 121; i++) codes.push((await get("6.6.6.6")).status);
    expect(codes.slice(0, 120).every((c) => c === 404)).toBe(true); // read, not found
    expect(codes[120]).toBe(429); // refused before the store is touched
    expect((await caseGet(new Request(`http://x/api/cases/${id}`, { headers: { "x-forwarded-for": "6.6.6.7" } }), { params: Promise.resolve({ id }) })).status).toBe(404);
    vi.unstubAllEnvs();
  });
});
