import { afterEach, describe, expect, it, vi } from "vitest";
import type { QlooCallLog, QlooClient } from "../lib/qloo";
import { claimWeekOne, coachRefills, Conflict, latestVersion, loosens, NotFound, planRunState, refreshDiff, RUN_STALE_MS, runPlanForCase, toggleConstraints, caseFromSeed } from "../lib/service";
import { CaseDoc, MemoryStore, PlanDoc, type QlooCallsDoc, type RunDoc, type RunDocIn } from "../lib/store";
import { makeLlm } from "../lib/llm";
import { replayClient } from "./replay";

// the default Qloo client of the service reads env and would call the network: replace it with the captured replay
const env = vi.hoisted(() => ({ qlooFromEnv: vi.fn() }));
vi.mock("../lib/qloo", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/qloo")>()), qlooFromEnv: env.qlooFromEnv }));

const replayFactory = (): QlooClient => replayClient();
const downLlm = () => makeLlm("qwen", { QWEN_API_KEY: "k" }, (async () => new Response("{}", { status: 400 })) as unknown as typeof fetch)!;
const t0 = Date.parse("2026-10-08T00:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const marker = (caseId: string, extra: Partial<RunDoc> = {}): RunDocIn => ({ case_id: caseId, status: "running", plan_id: null, started_at: iso(t0), updated_at: iso(t0), ...extra });

/** MemoryStore whose reads and writes can be made to fail or come back empty, one method at a time */
class FlakyStore extends MemoryStore {
  failGetRun = false;
  failGetPlan = false;
  noCalls = false;
  failPutFailed = false;
  private base = { getRun: this.getRun, getPlan: this.getPlan, getCalls: this.getCalls, putRun: this.putRun };
  override getRun = async (id: string): Promise<RunDoc | null> => (this.failGetRun ? Promise.reject(new Error("down")) : this.base.getRun(id));
  override getPlan = async (id: string): Promise<PlanDoc | null> => (this.failGetPlan ? Promise.reject(new Error("down")) : this.base.getPlan(id));
  override getCalls = async (id: string): Promise<QlooCallsDoc | null> => (this.noCalls ? null : this.base.getCalls(id));
  override putRun = async (d: RunDocIn): Promise<void> => (this.failPutFailed && d.status === "failed" ? Promise.reject(new Error("down")) : this.base.putRun(d));
}

async function mayaWeek(store: MemoryStore = new MemoryStore()) {
  const c = caseFromSeed("maya")!;
  await store.putCase(c);
  const plan = await runPlanForCase({ store, caseId: c.id, qloo: replayFactory, llms: [downLlm()] });
  return { store, c, plan };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("cov-c service: planRunState", () => {
  it.each([
    ["no marker", async () => undefined, null],
    ["a failed marker", async (s: MemoryStore, id: string) => s.putRun(marker(id, { status: "failed" })), null],
    ["a stale running marker", async (s: MemoryStore, id: string) => s.putRun(marker(id)), null],
  ])("%s: no run state", async (_n, setup, want) => {
    const s = new MemoryStore();
    const id = crypto.randomUUID();
    await setup(s, id);
    expect(await planRunState(s, id, t0 + RUN_STALE_MS)).toBe(want);
  });

  it("a fresh running marker is reported as running", async () => {
    const s = new MemoryStore();
    const id = crypto.randomUUID();
    await s.putRun(marker(id));
    expect(await planRunState(s, id, t0 + RUN_STALE_MS - 1)).toMatchObject({ running: { case_id: id } });
  });

  it("a done marker returns its plan, or null when the plan is missing or the store read fails", async () => {
    const s = new FlakyStore();
    const { c, plan } = await mayaWeek(s);
    expect(await planRunState(s, c.id)).toEqual({ plan });
    await s.putRun(marker(c.id, { status: "done", plan_id: crypto.randomUUID() }));
    expect(await planRunState(s, c.id)).toBeNull(); // the plan was never stored
    await s.putRun(marker(c.id, { status: "done", plan_id: plan.id }));
    s.failGetPlan = true;
    expect(await planRunState(s, c.id)).toBeNull();
    s.failGetRun = true;
    expect(await planRunState(s, c.id)).toBeNull();
  });
});

describe("cov-c service: claimWeekOne and runPlanForCase", () => {
  it("an unknown case is NotFound", async () => {
    const id = crypto.randomUUID();
    await expect(claimWeekOne(new MemoryStore(), id)).rejects.toBeInstanceOf(NotFound);
    await expect(runPlanForCase({ store: new MemoryStore(), caseId: id })).rejects.toThrow(`case ${id} not found`);
  });

  it("a claim over an existing marker: done+plan returns the plan; done without a stored plan, done without plan_id and running are all a 409 running Conflict", async () => {
    const { store, c, plan } = await mayaWeek();
    expect(await claimWeekOne(store, c.id)).toEqual({ plan });
    for (const m of [marker(c.id, { status: "done", plan_id: crypto.randomUUID(), started_at: iso(Date.now()) }), marker(c.id, { status: "done", plan_id: null, started_at: iso(Date.now()) }), marker(c.id, { started_at: iso(Date.now()) })]) {
      await store.putRun(m);
      const e = await claimWeekOne(store, c.id).catch((x) => x);
      expect(e).toBeInstanceOf(Conflict);
      expect((e as Conflict).body).toMatchObject({ running: true });
    }
  });

  it("a fresh claim returns claimed with the supplied time", async () => {
    const store = new MemoryStore();
    const c = caseFromSeed("maya")!;
    await store.putCase(c);
    expect(await claimWeekOne(store, c.id, t0)).toEqual({ claimed: { started_at: iso(t0) } });
  });

  it("runPlanForCase on a case whose week 1 is already stored returns that plan without a new run", async () => {
    const { store, c, plan } = await mayaWeek();
    const calls = vi.fn(replayFactory);
    expect(await runPlanForCase({ store, caseId: c.id, qloo: calls, llms: [] })).toEqual(plan);
    expect(calls).not.toHaveBeenCalled();
  });

  it("a failed run is marked failed and the error still propagates, even when marking it fails too", async () => {
    for (const failMark of [false, true]) {
      const store = new FlakyStore();
      const c = caseFromSeed("maya")!;
      await store.putCase(c);
      store.failPutFailed = failMark;
      const boom = () => {
        throw new Error("qloo factory exploded");
      };
      await expect(runPlanForCase({ store, caseId: c.id, qloo: boom as never, llms: [] })).rejects.toThrow("qloo factory exploded");
      expect((await store.getRun(c.id))?.status).toBe(failMark ? "running" : "failed");
    }
  });

  it("with no injected Qloo client or LLMs the service builds them from the environment", async () => {
    vi.stubEnv("QWEN_API_KEY", "");
    vi.stubEnv("GROQ_API_KEY", "");
    env.qlooFromEnv.mockImplementation((cb: (l: QlooCallLog) => void, o: { deadline?: number }) => {
      expect(o.deadline).toBeGreaterThan(Date.now());
      return replayFactory();
    });
    const store = new MemoryStore();
    const c = caseFromSeed("maya")!;
    await store.putCase(c);
    const plan = await runPlanForCase({ store, caseId: c.id });
    expect(env.qlooFromEnv).toHaveBeenCalledTimes(1);
    expect(plan.cards.length).toBeGreaterThan(0);
    expect(plan.llm_provider).toBeNull(); // no provider keys: the deterministic route
  });
});

describe("cov-c service: toggleConstraints", () => {
  it("unknown plan, orphaned plan and non-draft plan are refused", async () => {
    const { store, plan } = await mayaWeek();
    await expect(toggleConstraints({ store, planId: crypto.randomUUID(), patch: {}, qloo: replayFactory })).rejects.toBeInstanceOf(NotFound);
    const orphan = PlanDoc.parse({ ...plan, id: crypto.randomUUID(), case_id: crypto.randomUUID() });
    await store.putPlan(orphan);
    await expect(toggleConstraints({ store, planId: orphan.id, patch: {}, qloo: replayFactory })).rejects.toThrow(/case .* not found/);
  });

  it("loosening quiet and wheelchair retries empty slots; with no call log or llms from the caller it falls back to env defaults", async () => {
    vi.stubEnv("QWEN_API_KEY", "");
    vi.stubEnv("GROQ_API_KEY", "");
    env.qlooFromEnv.mockImplementation(() => replayFactory());
    const store = new FlakyStore();
    const base = caseFromSeed("maya")!;
    const c = CaseDoc.parse({ ...base, need_quiet: true, need_wheelchair: true });
    await store.putCase(c);
    const plan = await runPlanForCase({ store, caseId: c.id, qloo: replayFactory, llms: [] });
    store.noCalls = true;
    const quietOff = await toggleConstraints({ store, planId: plan.id, patch: { need_quiet: false } });
    expect(env.qlooFromEnv).toHaveBeenCalledTimes(1);
    expect(quietOff.case.need_quiet).toBe(false);
    expect(quietOff.plan.toggle?.changed).toEqual({ need_quiet: false });
    store.noCalls = false;
    expect((await store.getCalls(quietOff.plan.id))!.calls.length).toBe(quietOff.plan.qloo_calls); // no prior log: only this refill's calls
    store.noCalls = false;
    const wheelOff = await toggleConstraints({ store, planId: quietOff.plan.id, patch: { need_wheelchair: false }, qloo: replayFactory, llms: [] });
    expect(wheelOff.case.need_wheelchair).toBe(false);
  });
});

describe("cov-c service: loosens", () => {
  const c0 = (extra: Partial<CaseDoc> = {}) => CaseDoc.parse({ ...caseFromSeed("maya")!, in_recovery: true, need_quiet: true, need_wheelchair: true, ...extra });
  it.each([
    ["wider radius", { max_meters: 99999 }, true],
    ["higher budget", { price_max: 4 }, true],
    ["recovery off", { in_recovery: false }, true],
    ["quiet off", { need_quiet: false }, true],
    ["wheelchair off", { need_wheelchair: false }, true],
    ["nothing", {}, false],
    ["tighter radius, budget", { max_meters: 1, price_max: 0 }, false],
  ] as [string, Partial<CaseDoc>, boolean][])("%s -> %s", (_n, patch, want) => {
    const before = c0();
    expect(loosens(before, { ...before, ...patch })).toBe(want);
    // a flag that was never on cannot have been switched off
    expect(loosens(c0({ in_recovery: false, need_quiet: false, need_wheelchair: false }), c0({ in_recovery: false, need_quiet: false, need_wheelchair: false }))).toBe(false);
  });
});

describe("cov-c service: latestVersion, refreshDiff, coachRefills", () => {
  it("latestVersion follows the chain, stops at a missing or failing successor, and respects maxHops", async () => {
    const s = new FlakyStore();
    const { plan } = await mayaWeek(s);
    const b = PlanDoc.parse({ ...plan, id: crypto.randomUUID() });
    const a = PlanDoc.parse({ ...plan, superseded_by: b.id });
    await s.putPlan(b);
    await s.putPlan(a);
    expect((await latestVersion(s, a)).id).toBe(b.id);
    expect((await latestVersion(s, a, 0)).id).toBe(a.id);
    const dangling = PlanDoc.parse({ ...plan, id: crypto.randomUUID(), superseded_by: crypto.randomUUID() });
    expect((await latestVersion(s, dangling)).id).toBe(dangling.id); // successor never stored
    s.failGetPlan = true;
    expect((await latestVersion(s, a)).id).toBe(a.id); // read failure keeps the last known version
  });

  it("refreshDiff returns the plan untouched when it has no diff or the source week is gone", async () => {
    const s = new MemoryStore();
    const { plan } = await mayaWeek(s);
    expect(await refreshDiff(s, plan)).toBe(plan);
    const withDiff = PlanDoc.parse({ ...plan, diff: { from_plan_id: crypto.randomUUID(), kept: [], added: [], removed: [], signals: [], kept_check: null, ember: [] } });
    expect(await refreshDiff(s, withDiff)).toBe(withDiff);
  });

  it("coachRefills: with refills but an LLM that answers nothing usable, the plan keeps its template lines", async () => {
    const { plan } = await mayaWeek();
    const refilled = PlanDoc.parse({ ...plan, cards: plan.cards.map((x, i) => (i === 0 ? { ...x, routed_by: "toggle", coaching_by: "template" } : x)) });
    const out = await coachRefills(refilled, [downLlm()], 500);
    expect(out.cards.map((x) => x.coaching)).toEqual(refilled.cards.map((x) => x.coaching));
    expect(out.cards.every((x) => x.coaching_by === "template" || x.routed_by !== "toggle")).toBe(true);
  });
});
