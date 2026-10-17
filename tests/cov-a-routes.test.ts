/**
 * Coverage group a: the app/api route handlers' refusal, race and error arms. The store is an in-memory one the test
 * owns (lib/scope is stubbed to return it); the agent runs (plan, re-plan, constraint toggle) are stubbed, the rest of
 * every route is real. Rate limits are driven through the real limiter (env limits of 0, or a pre-filled window).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseSse } from "../lib/http";
import { limiterFromEnv } from "../lib/ratelimit";
import { ownerHash } from "../lib/owner";
import { caseFromSeed, type RunPlanOptions } from "../lib/service";
import { MemoryStore, newId, type CaseDoc, type PlanDoc, type Store } from "../lib/store";
import { QlooError } from "../lib/qloo";

const h = vi.hoisted(() => ({
  store: null as unknown as Store,
  runPlan: null as null | ((o: RunPlanOptions) => Promise<unknown>),
  replan: null as null | ((o: { planId: string; claimed?: { started_at: string }; onEvent?: (e: { type: string }) => void }) => Promise<unknown>),
  toggle: null as null | ((o: { planId: string; patch: unknown }) => Promise<unknown>),
  verify: null as null | ((qloo: { search: (q: string) => Promise<unknown> }, geo: unknown, b: unknown) => Promise<unknown>),
}));
vi.mock("../lib/scope", () => ({ storeFor: () => h.store }));
vi.mock("../lib/service", async (orig) => {
  const m = await orig<typeof import("../lib/service")>();
  return {
    ...m,
    runPlanForCase: (o: RunPlanOptions) => (h.runPlan ? h.runPlan(o) : m.runPlanForCase(o)),
    toggleConstraints: (o: Parameters<typeof m.toggleConstraints>[0]) => (h.toggle ? h.toggle(o) : m.toggleConstraints(o)),
  };
});
vi.mock("../lib/gate", async (orig) => {
  const m = await orig<typeof import("../lib/gate")>();
  return { ...m, replanWeek: (o: Parameters<typeof m.replanWeek>[0]) => (h.replan ? h.replan(o as never) : m.replanWeek(o)) };
});
vi.mock("../lib/venue", async (orig) => {
  const m = await orig<typeof import("../lib/venue")>();
  return { ...m, verifyVenue: (q: never, g: unknown, b: unknown) => (h.verify ? h.verify(q, g, b) : m.verifyVenue(q, g as never, b as never)), nominatim: () => (async () => null) as never };
});

import { POST as casesPost } from "../app/api/cases/route";
import { GET as caseGet } from "../app/api/cases/[id]/route";
import { POST as copyPost } from "../app/api/cases/[id]/copy/route";
import { POST as planPost } from "../app/api/cases/[id]/plan/route";
import { POST as seedPost } from "../app/api/cases/seed/[slug]/route";
import { PATCH as cardPatch } from "../app/api/plans/[id]/cards/[cardId]/route";
import { POST as approvePost } from "../app/api/plans/[id]/approve/route";
import { POST as constraintsPost } from "../app/api/plans/[id]/constraints/route";
import { POST as ratingsPost } from "../app/api/plans/[id]/ratings/route";
import { POST as replanPost } from "../app/api/plans/[id]/replan/route";
import { GET as planGet } from "../app/api/plans/[id]/route";
import { GET as resolveGet } from "../app/api/resolve/route";
import { POST as verifyPost } from "../app/api/verify-venue/route";

const TOKEN = "route-owner-token-0123456789abcdef";
const COOKIE = `rk_owner=${TOKEN}`;
const BENCH = "bench-token-0123456789abcdef";
let n = 0;
/** every request comes from its own IP, so the per-IP windows of other tests never interfere */
const ip = () => `10.20.${Math.floor(++n / 250)}.${n % 250}`;
const req = (url: string, method = "POST", o: { body?: unknown; raw?: string; cookie?: string | null; headers?: Record<string, string>; ip?: string } = {}) =>
  new Request(`http://x${url}`, {
    method,
    ...(o.raw !== undefined ? { body: o.raw } : o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
    headers: { "x-forwarded-for": o.ip ?? ip(), ...(o.cookie === null ? {} : { cookie: o.cookie ?? COOKIE }), ...o.headers },
  });
const ctx = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });
const body = async (r: Response) => (await r.json()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function seededCase(o: Partial<CaseDoc> = {}) {
  const c = { ...caseFromSeed("maya")!, owner_hash: ownerHash(TOKEN), ...o };
  await h.store.putCase(c);
  return c;
}

/** a stored week for a case: `rated` = approved + ≥ 3 ratings, as re-planning needs */
function planFor(c: CaseDoc, o: Partial<PlanDoc> = {}): PlanDoc {
  const card = (i: number) => ({
    id: newId(), plan_id: "p", day: i, day_name: "monday", hour: 10, slot_hour: 10, rung: "social", qloo_entity_id: `e${i}`, name: `Place ${i}`, entity_type: "urn:entity:place", affinity: 0.5,
    explain_json: [], tags: [], checks: [], verdict: "PASS", coaching: "", routed_by: "llm", tool_params: {}, clinician_action: null, pleasure: null, mastery: null,
  });
  return {
    id: newId(), case_id: c.id, week: 1, status: "draft", created_at: "2026-10-01T00:00:00.000Z", approved_at: null, parent_plan_id: null, llm_provider: null, llm_model: null, coach_llm: null,
    llm_steps: 0, llm_ms: 0, qloo_calls: 0, latency_ms: 1, history: { rekindled: [], lowRated: [], excludeTags: [], signalTags: [], struck: [] }, cards: [0, 1, 2, 3].map(card), empty_slots: [],
    refusals: [], review: [], dropped: [], llm_errors: [], origin: "agent", next_plan_id: null, superseded_by: null, diff: null, bench: null, fault: null, toggle: null, ...o,
  } as unknown as PlanDoc;
}
const rated = (c: CaseDoc, o: Partial<PlanDoc> = {}) => {
  const p = planFor(c, { status: "rated", ...o });
  return { ...p, cards: p.cards.map((k, i) => (i < 3 ? { ...k, plan_id: p.id, pleasure: 8, mastery: 5 } : { ...k, plan_id: p.id })) } as PlanDoc;
};

beforeEach(() => {
  h.store = new MemoryStore();
  h.runPlan = h.replan = h.toggle = h.verify = null;
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** the daily/per-IP limiter refuses from here on for this action (public namespace) */
const refuseAll = (...vars: string[]) => vars.forEach((v) => vi.stubEnv(v, "0"));
const expect429 = async (r: Response, reason = "ip") => {
  expect(r.status).toBe(429);
  expect(await body(r)).toMatchObject({ namespace: "public", reason, receipts: "/integrations/qloo" });
};
/** fill this IP's per-hour window for an action whose limit is a constant */
const fillWindow = (action: string, address: string, limit: number) => {
  for (let i = 0; i < limit; i++) limiterFromEnv().window.hit(`public:${action}:${address}`, limit);
};

describe("read routes", () => {
  it("GET /api/cases/:id: 200, 404, 429, and a malformed id is a 400 (never a 500)", async () => {
    const c = await seededCase();
    const ok = await caseGet(req(`/api/cases/${c.id}`, "GET"), ctx({ id: c.id }));
    expect(ok.status).toBe(200);
    expect((await body(ok)).case.id).toBe(c.id);
    const miss = await caseGet(req("/x", "GET"), ctx({ id: newId() }));
    expect(miss.status).toBe(404);
    expect(await body(miss)).toEqual({ error: "case not found" });
    const bad = await caseGet(req("/x", "GET"), ctx({ id: "../etc" }));
    expect(bad.status).toBe(400);
    expect(await body(bad)).toEqual({ error: "invalid id" });
    refuseAll("RL_PUBLIC_READS_PER_IP_HOUR");
    await expect429(await caseGet(req("/x", "GET"), ctx({ id: c.id })));
  });

  it("GET /api/plans/:id: the call log is only returned on ?calls=1, and an absent log is an empty list", async () => {
    const c = await seededCase();
    const p = planFor(c);
    await h.store.putPlan(p);
    const plain = await body(await planGet(req("/x", "GET"), ctx({ id: p.id })));
    expect(plain.plan.id).toBe(p.id);
    expect(plain).not.toHaveProperty("calls");
    const none = await body(await planGet(req("/x?calls=1", "GET"), ctx({ id: p.id })));
    expect(none.calls).toEqual([]);
    const call = { path: "/v2/insights", params: {}, params_json: {}, status: 200, ms: 5, n_results: 3, attempts: 1, at: "t" };
    await h.store.putCalls({ plan_id: p.id, calls: [call] } as never);
    expect((await body(await planGet(req("/x?calls=1", "GET"), ctx({ id: p.id })))).calls).toHaveLength(1);
    expect((await planGet(req("/x", "GET"), ctx({ id: newId() }))).status).toBe(404);
    expect((await planGet(req("/x", "GET"), ctx({ id: "nope" }))).status).toBe(400);
    refuseAll("RL_PUBLIC_READS_PER_IP_HOUR");
    await expect429(await planGet(req("/x", "GET"), ctx({ id: p.id })));
  });
});

describe("case creation routes", () => {
  it("POST /api/cases and /api/cases/seed/:slug are refused at the write limit; a store failure is a 500, not a stored case", async () => {
    refuseAll("RL_PUBLIC_WRITES_PER_IP_HOUR");
    await expect429(await casesPost(req("/api/cases", "POST", { body: {} })));
    await expect429(await seedPost(req("/api/cases/seed/maya"), ctx({ slug: "maya" })));
    vi.unstubAllEnvs();
    h.store = { putCase: async () => Promise.reject(new Error("disk full")) } as unknown as Store;
    const res = await seedPost(req("/api/cases/seed/maya"), ctx({ slug: "maya" }));
    expect(res.status).toBe(500);
    expect(await body(res)).toEqual({ error: "internal error" });
    expect(console.error).toHaveBeenCalled();
  });

  it("POST /api/cases/:id/copy: unknown case 404 (before the limiter), refused at the write limit, store failure 500, else a fresh owned copy", async () => {
    const src = await seededCase({ owner_hash: ownerHash("someone-else-token-0123456789abcdef") });
    const miss = await copyPost(req(`/api/cases/x/copy`), ctx({ id: newId() }));
    expect(miss.status).toBe(404);
    expect(await body(miss)).toEqual({ error: "case not found" });
    expect((await copyPost(req("/x"), ctx({ id: "bad id" }))).status).toBe(400);
    refuseAll("RL_PUBLIC_WRITES_PER_IP_HOUR");
    await expect429(await copyPost(req("/x"), ctx({ id: src.id })));
    vi.unstubAllEnvs();
    const ok = await copyPost(req("/x", "POST", { cookie: null }), ctx({ id: src.id }));
    expect(ok.status).toBe(201);
    const made = await body(ok);
    expect(made.copied_from).toBe(src.id);
    expect(made.case.id).not.toBe(src.id);
    expect(made.case.owner_hash).not.toBe(src.owner_hash);
    expect(made.case.loves.map((l: { id: string }) => l.id)).not.toEqual(src.loves.map((l) => l.id));
    expect(ok.headers.get("set-cookie")).toMatch(/^rk_owner=/);
    const real = h.store;
    h.store = { getCase: real.getCase, putCase: async () => Promise.reject(new Error("disk full")) } as unknown as Store;
    expect((await copyPost(req("/x"), ctx({ id: src.id }))).status).toBe(500);
  });
});

describe("owner-gated plan routes are refused at their limits after the owner check", () => {
  it("approve, ratings and card actions: 429 at the write limit (swap at the toggle limit); constraints at the toggle limit", async () => {
    const c = await seededCase();
    const p = planFor(c);
    await h.store.putPlan(p);
    refuseAll("RL_PUBLIC_WRITES_PER_IP_HOUR");
    await expect429(await approvePost(req("/x"), ctx({ id: p.id })));
    await expect429(await ratingsPost(req("/x", "POST", { body: { ratings: [{ card_id: "a", pleasure: 5 }] } }), ctx({ id: p.id })));
    await expect429(await cardPatch(req("/x", "PATCH", { body: { action: "remove" } }), ctx({ id: p.id, cardId: "c" })));
    // swap is limited like a toggle, so the write limit alone does not refuse it (it reaches the card lookup: 404)
    const swap = await cardPatch(req("/x", "PATCH", { body: { action: "swap" } }), ctx({ id: p.id, cardId: "missing-card" }));
    expect(swap.status).not.toBe(429);
    vi.unstubAllEnvs();
    refuseAll("RL_PUBLIC_TOGGLES_PER_IP_HOUR");
    await expect429(await cardPatch(req("/x", "PATCH", { body: { action: "swap" } }), ctx({ id: p.id, cardId: "c" })));
    await expect429(await constraintsPost(req("/x", "POST", { body: { need_quiet: true } }), ctx({ id: p.id })));
    // a visitor who does not own the case never reaches the limiter
    expect((await approvePost(req("/x", "POST", { cookie: null }), ctx({ id: p.id }))).status).toBe(403);
  });

  it("POST /api/plans/:id/constraints: the owner's patch reaches toggleConstraints and its result is returned with the limiter's headers", async () => {
    const c = await seededCase();
    const p = planFor(c);
    await h.store.putPlan(p);
    const seen: unknown[] = [];
    h.toggle = async (o) => {
      seen.push(o.patch);
      return { plan: { id: o.planId }, case: { id: c.id } };
    };
    const res = await constraintsPost(req("/x", "POST", { body: { need_quiet: true, max_meters: 800 } }), ctx({ id: p.id }));
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ plan: { id: p.id }, case: { id: c.id } });
    expect(res.headers.get("x-ratelimit-namespace")).toBe("public");
    expect(seen).toEqual([{ need_quiet: true, max_meters: 800 }]);
    expect((await constraintsPost(req("/x", "POST", { body: { unknown_field: 1 } }), ctx({ id: p.id }))).status).toBe(400);
  });
});

describe("POST /api/cases/:id/plan", () => {
  const sse = async (r: Response) => parseSse(await r.text());

  it("a body that is not JSON is a 400 `invalid body`", async () => {
    const c = await seededCase();
    const res = await planPost(req("/x", "POST", { raw: "{not json" }), ctx({ id: c.id }));
    expect(res.status).toBe(400);
    expect(await body(res)).toMatchObject({ error: "invalid body" });
  });

  it("the outage demo is limited like a toggle, a plan like a plan; a refused request starts no run", async () => {
    const c = await seededCase();
    let ran = 0;
    h.runPlan = async () => (ran++, {});
    refuseAll("RL_PUBLIC_TOGGLES_PER_IP_HOUR");
    await expect429(await planPost(req("/x", "POST", { body: { fault: "qloo_unreachable" } }), ctx({ id: c.id })));
    vi.unstubAllEnvs();
    refuseAll("RL_PUBLIC_PLANS_PER_IP_HOUR");
    await expect429(await planPost(req("/x", "POST", { body: {} }), ctx({ id: c.id })));
    expect(ran).toBe(0);
  });

  it("a bench arm whose namespace is not bench by the time the limiter answers is refused (defensive second check)", async () => {
    vi.stubEnv("BENCH_TOKEN", BENCH);
    const c = await seededCase();
    const real = limiterFromEnv();
    const check = real.check.bind(real);
    vi.spyOn(real, "check").mockImplementation(async (...a) => ({ ...(await check(...a)), ns: "judge" }));
    const res = await planPost(req("/x", "POST", { body: { bench: "B" }, headers: { "x-bench-token": BENCH } }), ctx({ id: c.id }));
    expect(res.status).toBe(403);
    expect(await body(res)).toEqual({ error: "bench arms need the bench token" });
  });

  it("losing the claim race: the week another request just stored is returned as JSON; a run still in flight is a 409 `running`", async () => {
    const c = await seededCase();
    const done = planFor(c);
    await h.store.putPlan(done);
    const real = limiterFromEnv();
    const check = real.check.bind(real);
    // runs between the route's precheck and its claim: another tab finishes (or starts) the run
    const interleave = (f: () => Promise<void>) => vi.spyOn(real, "check").mockImplementation(async (...a) => (await f(), check(...a)));
    interleave(() => h.store.putRun({ case_id: c.id, status: "done", plan_id: done.id, started_at: new Date().toISOString(), updated_at: new Date().toISOString() }));
    h.runPlan = async () => Promise.reject(new Error("must not run"));
    // planRunState reads the (absent) run first, then the hook above writes the marker, then claimWeekOne finds it
    const won = await planPost(req("/x", "POST", { body: {} }), ctx({ id: c.id }));
    expect(won.status).toBe(200);
    expect(await body(won)).toMatchObject({ plan: { id: done.id }, reused: true });

    const c2 = await seededCase();
    vi.restoreAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const check2 = real.check.bind(real);
    vi.spyOn(real, "check").mockImplementation(async (...a) => (await h.store.putRun({ case_id: c2.id, status: "running", started_at: new Date().toISOString(), updated_at: new Date().toISOString() }), check2(...a)));
    const busy = await planPost(req("/x", "POST", { body: {} }), ctx({ id: c2.id }));
    expect(busy.status).toBe(409);
    expect(await body(busy)).toMatchObject({ running: true });
  });

  it("a claimed run streams open → events → plan with the store's degraded flag", async () => {
    const c = await seededCase();
    h.runPlan = async (o) => {
      o.onEvent?.({ type: "start" } as never);
      return { id: "week-1", caseId: o.caseId, claimed: o.claimed };
    };
    const frames = await sse(await planPost(req("/x", "POST", { body: {} }), ctx({ id: c.id })));
    expect(frames.map((f) => f.event)).toEqual(["open", "start", "plan"]);
    expect(frames[2]!.data).toMatchObject({ plan: { id: "week-1", caseId: c.id, claimed: { started_at: expect.any(String) } }, degraded: false });
  });
});

describe("POST /api/plans/:id/replan", () => {
  const frames = async (r: Response) => parseSse(await r.text());

  it("an unknown week is 404; a week whose case is gone is 404; a visitor who does not own the case is 403 (all before the limiter)", async () => {
    const miss = await replanPost(req("/x"), ctx({ id: newId() }));
    expect(miss.status).toBe(404);
    const c = await seededCase();
    const orphan = rated({ ...c, id: newId() });
    await h.store.putPlan(orphan);
    const gone = await replanPost(req("/x"), ctx({ id: orphan.id }));
    expect(gone.status).toBe(404);
    expect((await body(gone)).error).toMatch(/case .* not found/);
    const p = rated(c);
    await h.store.putPlan(p);
    const foreign = await replanPost(req("/x", "POST", { cookie: null }), ctx({ id: p.id }));
    expect(foreign.status).toBe(403);
    expect(await body(foreign)).toMatchObject({ read_only: true });
  });

  it("a week that was already re-planned is returned as JSON without a run", async () => {
    const c = await seededCase();
    const next = planFor(c, { week: 2, origin: "replan" });
    const p = rated(c, { next_plan_id: next.id });
    await h.store.putPlan(next);
    await h.store.putPlan(p);
    h.replan = async () => Promise.reject(new Error("must not run"));
    const res = await replanPost(req("/x"), ctx({ id: p.id }));
    expect(res.status).toBe(200);
    expect(await body(res)).toMatchObject({ plan: { id: next.id }, reused: true });
  });

  it("refused at the plan limit; a concurrent winner's week is returned; a re-plan in flight is a 409 `running`", async () => {
    const c = await seededCase();
    const p = rated(c);
    await h.store.putPlan(p);
    refuseAll("RL_PUBLIC_PLANS_PER_IP_HOUR");
    await expect429(await replanPost(req("/x"), ctx({ id: p.id })));
    vi.unstubAllEnvs();

    const real = limiterFromEnv();
    const check = real.check.bind(real);
    const next = planFor(c, { week: 2, origin: "replan" });
    await h.store.putPlan(next);
    const at = new Date().toISOString();
    vi.spyOn(real, "check").mockImplementation(async (...a) => (await h.store.putRun({ case_id: c.id, parent_plan_id: p.id, status: "done", plan_id: next.id, started_at: at, updated_at: at }), check(...a)));
    const won = await replanPost(req("/x"), ctx({ id: p.id }));
    expect(won.status).toBe(200);
    expect(await body(won)).toMatchObject({ plan: { id: next.id }, reused: true });

    const p2 = rated(c);
    await h.store.putPlan(p2);
    vi.restoreAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const check2 = real.check.bind(real);
    vi.spyOn(real, "check").mockImplementation(async (...a) => (await h.store.putRun({ case_id: c.id, parent_plan_id: p2.id, status: "running", plan_id: null, started_at: new Date().toISOString(), updated_at: at }), check2(...a)));
    const busy = await replanPost(req("/x"), ctx({ id: p2.id }));
    expect(busy.status).toBe(409);
    expect(await body(busy)).toMatchObject({ running: true });
  });

  it("a claimed re-plan streams open → events → plan with `reused` and the degraded flag", async () => {
    const c = await seededCase();
    const p = rated(c);
    await h.store.putPlan(p);
    const claims: unknown[] = [];
    h.replan = async (o) => {
      claims.push(o.claimed);
      o.onEvent?.({ type: "start" });
      return { plan: { id: "week-2" }, reused: false };
    };
    const res = await replanPost(req("/x"), ctx({ id: p.id }));
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const fr = await frames(res);
    expect(fr.map((f) => f.event)).toEqual(["open", "start", "plan"]);
    expect(fr[2]!.data).toEqual({ plan: { id: "week-2" }, reused: false, degraded: false });
    expect(claims).toEqual([{ started_at: expect.any(String) }]);
  });
});

describe("GET /api/resolve", () => {
  it("is refused at the resolve limit before it reads the query", async () => {
    const address = "9.9.9.9";
    fillWindow("resolve", address, 120);
    await expect429(await resolveGet(req("/api/resolve?text=ramen&kind=place_tag", "GET", { ip: address })));
    // other addresses are unaffected; a bad kind is a 400
    expect((await resolveGet(req("/api/resolve?text=ramen&kind=nope", "GET"))).status).toBe(400);
  });
});

describe("POST /api/verify-venue", () => {
  const venue = { name: "Dun-Well Doughnuts", address: "222 Montrose Ave", day: "thursday", hour: 15 };
  const bench = (b: unknown = venue) => req("/api/verify-venue", "POST", { body: b, cookie: null, headers: { "x-bench-token": BENCH } });

  it("is refused at the resolve limit for the public namespace, and bench-only otherwise", async () => {
    vi.stubEnv("BENCH_TOKEN", BENCH);
    const address = "9.9.8.8";
    fillWindow("resolve", address, 120);
    await expect429(await verifyPost(req("/api/verify-venue", "POST", { body: venue, ip: address })));
    const notBench = await verifyPost(req("/api/verify-venue", "POST", { body: venue }));
    expect(notBench.status).toBe(403);
    expect(await body(notBench)).toEqual({ error: "bench only" });
  });

  it("returns the verdict with the Qloo calls it made (path, status, ms, result count; never the key)", async () => {
    vi.stubEnv("BENCH_TOKEN", BENCH);
    vi.stubEnv("QLOO_API_KEY", "secret-qloo-key");
    vi.stubGlobal("fetch", async () => Response.json({ results: [{ entity_id: "e", name: "x" }, { entity_id: "f", name: "y" }] }));
    h.verify = async (qloo, _geo, b) => {
      await qloo.search((b as { name: string }).name);
      return { name: (b as { name: string }).name, verifiable: true };
    };
    const res = await verifyPost(bench());
    expect(res.status).toBe(200);
    const out = await body(res);
    expect(out.verdict).toEqual({ name: "Dun-Well Doughnuts", verifiable: true });
    expect(out.calls).toEqual([{ path: "/search", status: 200, ms: expect.any(Number), n_results: 2 }]);
    expect(JSON.stringify(out)).not.toContain("secret-qloo-key");
  });

  it("a Nominatim failure is a 502 with its message; any other failure maps through the shared handler", async () => {
    vi.stubEnv("BENCH_TOKEN", BENCH);
    vi.stubEnv("QLOO_API_KEY", "secret-qloo-key");
    h.verify = async () => Promise.reject(new Error("Nominatim returned 503"));
    const bad = await verifyPost(bench());
    expect(bad.status).toBe(502);
    expect(await body(bad)).toEqual({ error: "Nominatim returned 503" });
    h.verify = async () => Promise.reject(new QlooError("Qloo down", 500, "/search"));
    expect((await verifyPost(bench())).status).toBe(500);
    h.verify = async () => Promise.reject("not even an Error");
    expect((await verifyPost(bench())).status).toBe(500);
    expect((await verifyPost(bench({ name: "x" }))).status).toBe(400); // needs an address, point or entity_id
  });
});
