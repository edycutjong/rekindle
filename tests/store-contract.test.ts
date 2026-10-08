import { describe, expect, it } from "vitest";
import { EMPTY_HISTORY } from "../lib/plan";
import { counterFromEnv, RedisDailyCounter } from "../lib/ratelimit";
import { caseFromSeed } from "../lib/service";
import { callsDoc, CorruptDocument, MemoryStore, PlanDoc, planDocFromAgent, RedisStore, storeFromEnv, type RunDoc, type Store, type StorePrefix } from "../lib/store";
import { probeRedis } from "../lib/health";
import { FakeRedis } from "./fake-redis";

/**
 * One contract, two backends (a2a r06): the in-memory store every test uses and the Upstash Redis store that replaces
 * Blob, on an in-process fake. Same paths, zod on every read and write, create-only / compare-and-set run claims with
 * a lost race returning the winner, and a newest-first plan index without replaced weeks or the outage demo.
 */
const backends: [string, () => (prefix?: StorePrefix) => Store][] = [
  [
    "memory",
    () => {
      const m = new MemoryStore();
      return (prefix = "") => m.withPrefix(prefix);
    },
  ],
  [
    "redis (fake)",
    () => {
      const r = new FakeRedis();
      return (prefix = "") => new RedisStore(r, prefix, "");
    },
  ],
];

const emptyAgentPlan = { week: 1, slots: [], refusals: [], review: [], calls: [], llm: null, llmSteps: 0, llmMs: 0, llmErrors: [], dropped: [], latencyMs: 1 };
const plan = (createdAt: string, extra: Partial<PlanDoc> = {}): PlanDoc => PlanDoc.parse({ ...planDocFromAgent(emptyAgentPlan, { caseId: crypto.randomUUID(), history: EMPTY_HISTORY, calls: 0 }), created_at: createdAt, ...extra });
const run = (caseId: string, status: RunDoc["status"], startedAt = "2026-10-08T00:00:00.000Z", parent: string | null = null) => ({ case_id: caseId, parent_plan_id: parent, status, plan_id: null, started_at: startedAt, updated_at: startedAt });

for (const [name, make] of backends) {
  describe(`QA round 4 (a2a r06): Store contract — ${name}`, () => {
    it(`QA round 4 (a2a r06): ${name}: documents round-trip through zod; unknown ids read null; malformed ids and invalid documents are refused`, async () => {
      const store = make()();
      const c = caseFromSeed("maya")!;
      await store.putCase(c);
      expect(await store.getCase(c.id)).toEqual(c);
      const p = plan("2026-10-08T01:00:00.000Z", { case_id: c.id });
      await store.putPlan(p);
      expect(await store.getPlan(p.id)).toEqual(p);
      const calls = callsDoc(p.id, [{ path: "/v2/insights", params: { "filter.type": "urn:entity:place" }, status: 200, ms: 120, n_results: 5, attempts: 1, at: "2026-10-08T01:00:00Z" }]);
      await store.putCalls(calls);
      expect(await store.getCalls(p.id)).toEqual(calls);
      await store.putRun(run(c.id, "done"));
      expect((await store.getRun(c.id))?.status).toBe("done");
      expect(await store.getReplanRun(p.id)).toBeNull();
      const unknown = crypto.randomUUID();
      expect([await store.getCase(unknown), await store.getPlan(unknown), await store.getCalls(unknown), await store.getRun(unknown)]).toEqual([null, null, null, null]);
      await expect(store.getPlan("../cases/x")).rejects.toThrow("invalid id");
      await expect(async () => store.putCase({ ...c, energy: 9 } as never)).rejects.toThrow();
      expect((await store.getCase(c.id))?.energy).toBe(c.energy);
    });

    it(`QA round 4 (a2a r06): ${name}: listPlanIds is newest-created first, honours the limit, and never lists a replaced week or the outage demo`, async () => {
      const store = make()();
      const a = plan("2026-10-08T01:00:00.000Z");
      const b = plan("2026-10-08T03:00:00.000Z");
      const cc = plan("2026-10-08T02:00:00.000Z");
      const fault = plan("2026-10-08T04:00:00.000Z", { fault: "qloo_unreachable" });
      for (const p of [a, b, cc, fault]) await store.putPlan(p);
      expect(await store.listPlanIds()).toEqual([b.id, cc.id, a.id]);
      expect(await store.listPlanIds(2)).toEqual([b.id, cc.id]);
      // re-writing a plan (approve, rate) keeps its place: the order is creation, not the last write
      await store.putPlan({ ...a, status: "approved" });
      expect(await store.listPlanIds()).toEqual([b.id, cc.id, a.id]);
      // a constraint toggle replaces b: the newer week is listed, b leaves the index
      const child = plan("2026-10-08T05:00:00.000Z", { parent_plan_id: b.id, origin: "toggle" });
      await store.putPlan(child);
      await store.putPlan({ ...b, superseded_by: child.id });
      expect(await store.listPlanIds()).toEqual([child.id, cc.id, a.id]);
      expect(await store.getPlan(b.id)).toMatchObject({ superseded_by: child.id });
    });

    it(`QA round 4 (a2a r06): ${name}: claimRun is create-only, compare-and-set over a reclaimable marker, and a lost race returns the winner`, async () => {
      const store = make()();
      const caseId = crypto.randomUUID();
      const never = () => false;
      expect(await store.claimRun(run(caseId, "running", "2026-10-08T00:00:00.000Z"), never)).toBeNull();
      const blocked = await store.claimRun(run(caseId, "running", "2026-10-08T00:00:05.000Z"), never);
      expect(blocked).toMatchObject({ status: "running", started_at: "2026-10-08T00:00:00.000Z" });
      // a failed marker is reclaimable: replaced in place
      await store.putRun(run(caseId, "failed"));
      expect(await store.claimRun(run(caseId, "running", "2026-10-08T00:01:00.000Z"), (r) => r.status === "failed")).toBeNull();
      expect((await store.getRun(caseId))?.started_at).toBe("2026-10-08T00:01:00.000Z");
      // two concurrent claims of a fresh marker: exactly one wins, the other gets the winner's marker
      const fresh = crypto.randomUUID();
      const [x, y] = await Promise.all([store.claimRun(run(fresh, "running", "2026-10-08T00:02:00.000Z"), never), store.claimRun(run(fresh, "running", "2026-10-08T00:02:01.000Z"), never)]);
      expect([x, y].filter((r) => r === null)).toHaveLength(1);
      const stored = await store.getRun(fresh);
      expect((x ?? y)!.started_at).toBe(stored!.started_at);
      // two concurrent reclaims of one failed marker: one wins, the loser sees the winner's marker
      await store.putRun(run(fresh, "failed"));
      const failed = (r: RunDoc) => r.status === "failed";
      const [p, q] = await Promise.all([store.claimRun(run(fresh, "running", "2026-10-08T00:03:00.000Z"), failed), store.claimRun(run(fresh, "running", "2026-10-08T00:03:01.000Z"), failed)]);
      expect([p, q].filter((r) => r === null)).toHaveLength(1);
      expect((p ?? q)!.started_at).toBe((await store.getRun(fresh))!.started_at);
      expect((p ?? q)!.status).toBe("running");
      // a re-plan marker lives at its own path
      const parent = crypto.randomUUID();
      expect(await store.claimRun(run(caseId, "running", "2026-10-08T00:04:00.000Z", parent), never)).toBeNull();
      expect((await store.getReplanRun(parent))?.parent_plan_id).toBe(parent);
      expect((await store.getRun(caseId))?.started_at).toBe("2026-10-08T00:01:00.000Z");
    });

    it(`QA round 4 (a2a r06): ${name}: the bench/ prefix never sees product documents or plans`, async () => {
      const at = make();
      const pub = at("");
      const bench = at("bench/");
      const p = plan("2026-10-08T01:00:00.000Z");
      await pub.putPlan(p);
      expect(await bench.getPlan(p.id)).toBeNull();
      expect(await bench.listPlanIds()).toEqual([]);
      expect(await pub.listPlanIds()).toEqual([p.id]);
    });
  });
}

describe("QA round 4 (a2a r06): RedisStore specifics", () => {
  it("QA round 4 (a2a r06): keys are the Blob paths (preview/ off production); a plan write is one MULTI; the index is one ZRANGE, no scan", async () => {
    const r = new FakeRedis();
    const prod = new RedisStore(r, "", "");
    const p = plan("2026-10-08T01:00:00.000Z");
    await prod.putPlan(p);
    expect(r.strings.has(`plans/${p.id}.json`)).toBe(true);
    expect([...r.zsets.keys()]).toEqual(["idx/plans"]);
    expect(r.log).toEqual(["MULTI[SET,ZADD]"]);
    r.log.length = 0;
    await prod.listPlanIds(5);
    expect(r.log).toEqual(["ZRANGE"]);
    const preview = new RedisStore(r, "bench/", "preview/");
    await preview.putPlan(p);
    expect(r.strings.has(`preview/bench/plans/${p.id}.json`)).toBe(true);
    expect(r.zsets.has("preview/bench/idx/plans")).toBe(true);
    expect(await preview.listPlanIds()).toEqual([p.id]);
    expect(await new RedisStore(r, "bench/", "").listPlanIds()).toEqual([]);
  });

  it("QA round 4 (a2a r06): a stored value that is not JSON, or fails the schema, is a CorruptDocument (500), never a client 400", async () => {
    const r = new FakeRedis();
    const s = new RedisStore(r, "", "");
    const id = crypto.randomUUID();
    r.strings.set(`plans/${id}.json`, "{not json");
    await expect(s.getPlan(id)).rejects.toBeInstanceOf(CorruptDocument);
    r.strings.set(`cases/${id}.json`, JSON.stringify({ id }));
    await expect(s.getCase(id)).rejects.toBeInstanceOf(CorruptDocument);
  });

  it("QA round 4 (a2a r06): storeFromEnv precedence is Redis → Blob → memory; STORE_BACKEND=blob is the rollback", () => {
    const kv = { KV_REST_API_URL: "https://example.upstash.io", KV_REST_API_TOKEN: "t0k" };
    expect(storeFromEnv({ ...kv, BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_x" }).kind).toBe("redis");
    expect(storeFromEnv({ UPSTASH_REDIS_REST_URL: "https://example.upstash.io", UPSTASH_REDIS_REST_TOKEN: "t0k" }).kind).toBe("redis");
    expect(storeFromEnv({ ...kv, BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_x", STORE_BACKEND: "blob" }).kind).toBe("blob");
    expect(storeFromEnv({ KV_REST_API_URL: "https://example.upstash.io" }).kind).toBe("memory"); // half-configured is not configured
    expect(storeFromEnv({ BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_x" }).kind).toBe("blob");
    expect(() => storeFromEnv({ VERCEL: "1" })).toThrow(/KV_REST_API_URL/);
    expect(storeFromEnv({}).kind).toBe("memory");
    expect(counterFromEnv({ ...kv, BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_x" }).kind).toBe("redis");
    expect(counterFromEnv({ ...kv, BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_x", STORE_BACKEND: "blob" }).kind).toBe("blob");
    expect(counterFromEnv({}).kind).toBe("memory");
  });

  it("QA round 4 (a2a r06): the Redis daily counter is one atomic INCR (+ a 3-day expiry) per plan, per namespace and day", async () => {
    const r = new FakeRedis();
    const c = new RedisDailyCounter(r, "");
    expect(await c.get("public", "2026-10-08")).toBe(0);
    const all = await Promise.all(Array.from({ length: 25 }, () => c.incr("public", "2026-10-08")));
    expect(new Set(all).size).toBe(25); // no two instances ever see the same count
    expect(await c.get("public", "2026-10-08")).toBe(25);
    expect(await c.get("judge", "2026-10-08")).toBe(0);
    expect(r.ttl.get("counters/public/2026-10-08")).toBe(3 * 86_400);
    expect(r.log.filter((x) => x.startsWith("PIPELINE"))[0]).toBe("PIPELINE[INCR,EXPIRE]");
    await new RedisDailyCounter(r, "preview/").incr("public", "2026-10-08");
    expect(r.strings.get("preview/counters/public/2026-10-08")).toBe("1");
    await expect(c.incr("public", "../x")).rejects.toThrow("invalid day");
  });

  it("QA round 4 (a2a r06): the deep health check on Redis is one PING (no Blob call); a failed PING is a failed probe", async () => {
    const r = new FakeRedis();
    expect(await probeRedis(() => r.ping())).toMatchObject({ ok: true, detail: "redis PING → PONG" });
    r.fail = new Error("ERR max requests limit exceeded");
    expect(await probeRedis(() => r.ping())).toMatchObject({ ok: false, detail: "ERR max requests limit exceeded" });
  });
});

describe("QA round 4 (a2a r06): scripts/migrate-to-redis.ts", () => {
  it("QA round 4 (a2a r06): copies the named week and every linked week, case, call log and run marker by path, never a list()", async () => {
    const { migrate } = await import("../scripts/migrate-to-redis");
    const from = new MemoryStore();
    const c = caseFromSeed("maya")!;
    await from.putCase(c);
    const w1 = plan("2026-10-08T01:00:00.000Z", { case_id: c.id, status: "rated" });
    const w2 = plan("2026-10-08T02:00:00.000Z", { case_id: c.id, week: 2, parent_plan_id: w1.id, origin: "replan" });
    await from.putPlan({ ...w1, next_plan_id: w2.id });
    await from.putPlan(w2);
    await from.putCalls(callsDoc(w1.id, []));
    await from.putRun({ ...run(c.id, "done"), plan_id: w1.id });
    await from.putRun({ ...run(c.id, "done", "2026-10-08T02:00:00.000Z", w1.id), plan_id: w2.id });
    let listed = 0;
    const spy = new Proxy(from, { get: (t, k, rcv) => (k === "listPlanIds" ? () => (listed++, Promise.resolve([])) : Reflect.get(t, k, rcv)) });
    const r = new FakeRedis();
    const to = new RedisStore(r, "", "");
    const out = await migrate(spy, to, [w2.id, crypto.randomUUID()], () => {});
    expect(listed).toBe(0);
    expect(out).toMatchObject({ weeks: 2, cases: 2, calls: 1, runs: 3 });
    expect(out.missing).toHaveLength(1);
    expect(await to.getPlan(w1.id)).toMatchObject({ next_plan_id: w2.id });
    expect(await to.getCase(c.id)).toEqual(c);
    expect((await to.getReplanRun(w1.id))?.plan_id).toBe(w2.id);
    expect(await to.listPlanIds()).toEqual([w2.id, w1.id]);
  });
});
