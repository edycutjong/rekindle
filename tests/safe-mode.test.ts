import { afterEach, describe, expect, it, vi } from "vitest";
import { errorResponse } from "../lib/http";
import { RateLimiter, type DailyCounter } from "../lib/ratelimit";
import { readDoc } from "../lib/reads";
import { caseFromSeed } from "../lib/service";
import { BlobStore, CIRCUIT_MS, CorruptDocument, FailoverStore, MemoryStore, RedisStore, resetFailover, storeDegraded, storeFromEnv, StoreUnavailable, toStoreError } from "../lib/store";
import { FakeRedis } from "./fake-redis";

// No request ever leaves the test: the Blob SDK is replaced by stubs that fail the way a suspended store does.
const blob = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), list: vi.fn() }));
vi.mock("@vercel/blob", async (importOriginal) => ({ ...(await importOriginal<typeof import("@vercel/blob")>()), get: blob.get, put: blob.put, list: blob.list }));

const ctx = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });

describe("QA round 4 (a2a r06): safe mode (lib/store.ts FailoverStore, lib/http.ts, lib/reads.ts)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetFailover();
  });

  it("QA round 4 (a2a r06): every backend SDK failure is StoreUnavailable; zod, invalid ids and CorruptDocument keep their meaning", async () => {
    const r = new FakeRedis();
    const s = new RedisStore(r, "", "");
    r.fail = new Error("ERR max requests limit exceeded");
    await expect(s.getPlan(crypto.randomUUID())).rejects.toBeInstanceOf(StoreUnavailable);
    await expect(s.putCase(caseFromSeed("maya")!)).rejects.toBeInstanceOf(StoreUnavailable);
    await expect(s.listPlanIds()).rejects.toBeInstanceOf(StoreUnavailable);
    await expect(s.getPlan("../x")).rejects.toThrow("invalid id");
    expect(toStoreError(new CorruptDocument("x"))).toBeInstanceOf(CorruptDocument);
    const u = new StoreUnavailable();
    expect(toStoreError(u)).toBe(u);
    expect(toStoreError(new TypeError("fetch failed"))).toBeInstanceOf(StoreUnavailable);
  });

  it("QA round 4 (a2a r06): a suspended Blob store is StoreUnavailable on get, put, claim and list (SDK stubbed, no network)", async () => {
    const { BlobStoreSuspendedError } = await import("@vercel/blob");
    blob.get.mockRejectedValue(new BlobStoreSuspendedError());
    blob.put.mockRejectedValue(new BlobStoreSuspendedError());
    blob.list.mockRejectedValue(new BlobStoreSuspendedError());
    const s = new BlobStore("vercel_blob_rw_test");
    await expect(s.getPlan(crypto.randomUUID())).rejects.toBeInstanceOf(StoreUnavailable);
    await expect(s.putCase(caseFromSeed("maya")!)).rejects.toBeInstanceOf(StoreUnavailable);
    await expect(s.claimRun({ case_id: crypto.randomUUID(), status: "running", started_at: "x", updated_at: "x" }, () => true)).rejects.toBeInstanceOf(StoreUnavailable);
    await expect(s.listPlanIds()).rejects.toBeInstanceOf(StoreUnavailable);
    blob.get.mockResolvedValue(null);
    expect(await s.getPlan(crypto.randomUUID())).toBeNull(); // a 404 is still "missing"
  });

  it("QA round 4 (a2a r06): the circuit opens on StoreUnavailable, writes land in memory, a miss while degraded is unavailable (not missing), and outage docs survive recovery", async () => {
    let now = 1_000_000;
    const r = new FakeRedis();
    const f = new FailoverStore(new RedisStore(r, "", ""), new MemoryStore(), () => now);
    const before = caseFromSeed("maya")!;
    await f.putCase(before); // written while healthy
    r.fail = new Error("fetch failed");
    const during = caseFromSeed("theo")!;
    await f.putCase(during);
    expect(f.degraded()).toBe(true);
    expect(f.kind).toBe("redis");
    expect(await f.getCase(during.id)).toEqual(during);
    await expect(f.getCase(before.id)).rejects.toBeInstanceOf(StoreUnavailable); // exists, but cannot be read
    await expect(f.getPlan(crypto.randomUUID())).rejects.toBeInstanceOf(StoreUnavailable);
    expect(await f.getRun(crypto.randomUUID())).toBeNull(); // "no run yet" is a normal answer
    expect(await f.claimRun({ case_id: during.id, status: "running", started_at: "a", updated_at: "a" }, () => false)).toBeNull();
    const calls = r.log.length;
    await f.getCase(during.id);
    expect(r.log.length).toBe(calls); // open circuit: the backend is left alone
    // five minutes later the backend is back
    r.fail = null;
    now += CIRCUIT_MS;
    expect(f.degraded()).toBe(false);
    expect(await f.getCase(before.id)).toEqual(before);
    expect(await f.getCase(during.id)).toEqual(during); // made during the outage, still readable from memory
    expect((await f.getRun(during.id))?.status).toBe("running");
    expect(await f.getCase(crypto.randomUUID())).toBeNull(); // healthy again: a miss is a miss
  });

  it("QA round 4 (a2a r06): a corrupt document or an invalid id never opens the circuit", async () => {
    const r = new FakeRedis();
    const f = new FailoverStore(new RedisStore(r, "", ""), new MemoryStore());
    const id = crypto.randomUUID();
    r.strings.set(`plans/${id}.json`, "{bad");
    await expect(f.getPlan(id)).rejects.toBeInstanceOf(CorruptDocument);
    await expect(f.getPlan("nope")).rejects.toThrow("invalid id");
    expect(f.degraded()).toBe(false);
  });

  it("QA round 4 (a2a r06): StoreUnavailable is a 503 with retry-after (never a 500); CorruptDocument stays a 500", async () => {
    const r = errorResponse(new StoreUnavailable(new Error("suspended")));
    expect(r.status).toBe(503);
    expect(r.headers.get("retry-after")).toBe("60");
    expect(await r.json()).toMatchObject({ store: "unavailable" });
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(errorResponse(new CorruptDocument("x")).status).toBe(500);
    vi.restoreAllMocks();
  });

  it("QA round 4 (a2a r06): page reads tell down from missing", async () => {
    expect(await readDoc(async () => ({ id: "x" }))).toEqual({ doc: { id: "x" } });
    expect(await readDoc(async () => null)).toEqual({ missing: true });
    expect(await readDoc(async () => Promise.reject(new StoreUnavailable()))).toEqual({ down: true });
    expect(await readDoc(async () => Promise.reject(new CorruptDocument("x")))).toEqual({ missing: true });
    expect(await readDoc(async () => Promise.reject(new Error("invalid id")))).toEqual({ missing: true });
  });

  it("QA round 4 (a2a r06): a counter that cannot be read or written falls back to a per-instance count: the cap still refuses, never 'unknown'", async () => {
    const broken: DailyCounter = { kind: "redis", get: async () => Promise.reject(new Error("ERR max requests limit exceeded")), incr: async () => Promise.reject(new Error("down")) };
    const rl = new RateLimiter(broken, { RL_PUBLIC_DAILY_PLANS: "2" });
    const req = (ip: string) => new Request("http://x", { headers: { "x-forwarded-for": ip } });
    const out = [];
    for (const ip of ["1.1.1.1", "2.2.2.2", "3.3.3.3"]) out.push(await rl.check(req(ip), "plan"));
    expect(out.map((d) => d.ok)).toEqual([true, true, false]);
    expect(out.map((d) => d.headers["x-ratelimit-daily-remaining"])).toEqual(["1", "0", "0"]);
    expect(out[0]!.headers["x-ratelimit-counter"]).toBe("instance");
    // readable but not writable: the count continues on the instance
    let shared = 0;
    const halfBroken: DailyCounter = { kind: "redis", get: async () => shared, incr: async () => Promise.reject(new Error("down")) };
    const rl2 = new RateLimiter(halfBroken, { RL_PUBLIC_DAILY_PLANS: "5" });
    shared = 1;
    const d = await rl2.check(req("4.4.4.4"), "plan");
    expect(d).toMatchObject({ ok: true });
    expect(d.headers["x-ratelimit-daily-remaining"]).toBe("3"); // 5 − (shared 1 + this plan)
  });

  it("QA round 4 (a2a r06): STORE_FAULT=unavailable opens the circuit end to end off production; production ignores it", async () => {
    expect(storeFromEnv({ STORE_FAULT: "unavailable", VERCEL_ENV: "production" })).toBeInstanceOf(MemoryStore);
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
    vi.stubEnv("KV_REST_API_URL", "");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("STORE_FAULT", "unavailable");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { POST: seed } = await import("../app/api/cases/seed/[slug]/route");
    const { GET: getCase } = await import("../app/api/cases/[id]/route");
    const { GET: getPlan } = await import("../app/api/plans/[id]/route");
    expect(storeDegraded()).toBe(false);
    const made = await seed(new Request("http://x/api/cases/seed/maya", { method: "POST", headers: { "x-forwarded-for": "5.5.5.1" } }), ctx({ slug: "maya" }));
    expect(made.status).toBe(201); // the visitor still gets a case, in this instance's memory
    expect(made.headers.get("x-store-degraded")).toBe("1");
    expect(storeDegraded()).toBe(true);
    const { case: c } = await made.json();
    expect((await getCase(new Request(`http://x/api/cases/${c.id}`, { headers: { "x-forwarded-for": "5.5.5.1" } }), ctx({ id: c.id }))).status).toBe(200);
    const miss = await getPlan(new Request("http://x", { headers: { "x-forwarded-for": "5.5.5.1" } }), ctx({ id: crypto.randomUUID() }));
    expect(miss.status).toBe(503);
    expect(miss.headers.get("retry-after")).toBe("60");
    vi.restoreAllMocks();
  });
});
