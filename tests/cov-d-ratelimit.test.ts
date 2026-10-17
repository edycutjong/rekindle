import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeRedis } from "./fake-redis";

const blob = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
vi.mock("@vercel/blob", async (importOriginal) => ({ ...(await importOriginal<typeof import("@vercel/blob")>()), get: blob.get, put: blob.put }));

import { BlobDailyCounter, MemoryWindow, RedisDailyCounter, refused, type Decision } from "../lib/ratelimit";

beforeEach(() => {
  blob.get.mockReset();
  blob.put.mockReset();
});

const stream = (text: string) => new Response(text).body;

describe("cov-d ratelimit", () => {
  it("MemoryWindow purges expired keys once more than 10k are tracked", () => {
    const w = new MemoryWindow(1000);
    for (let i = 0; i < 10_001; i++) w.hit(`k${i}`, 5, 0);
    expect(w.hit("fresh", 5, 5000)).toMatchObject({ ok: true, remaining: 4 });
    // the old keys were purged: k0 starts a new window
    expect(w.hit("k0", 5, 5000)).toMatchObject({ remaining: 4 });
  });

  it("MemoryWindow keeps unexpired keys during the purge pass", () => {
    const w = new MemoryWindow(1000);
    for (let i = 0; i < 10_001; i++) w.hit(`k${i}`, 5, 0);
    expect(w.hit("k0", 5, 10)).toMatchObject({ remaining: 3 });
  });

  it("BlobDailyCounter.get: null/streamless is 0, n is read, non-number n is 0, and a bad day throws", async () => {
    const c = new BlobDailyCounter("tok");
    blob.get.mockResolvedValueOnce(null);
    expect(await c.get("public", "2026-10-17")).toBe(0);
    blob.get.mockResolvedValueOnce({ stream: null });
    expect(await c.get("public", "2026-10-17")).toBe(0);
    blob.get.mockResolvedValueOnce({ stream: stream('{"n":7}') });
    expect(await c.get("judge", "2026-10-17")).toBe(7);
    expect(blob.get).toHaveBeenLastCalledWith("counters/judge/2026-10-17.json", { access: "private", token: "tok", useCache: false });
    blob.get.mockResolvedValueOnce({ stream: stream('{"n":"7"}') });
    expect(await c.get("judge", "2026-10-17")).toBe(0);
    await expect(c.get("public", "../etc")).rejects.toThrow("invalid day");
  });

  it("BlobDailyCounter.incr: writes n+1 and returns it; a failed read propagates without writing", async () => {
    const c = new BlobDailyCounter("tok");
    blob.get.mockResolvedValueOnce({ stream: stream('{"n":4}') });
    blob.put.mockResolvedValueOnce({});
    expect(await c.incr("bench", "2026-10-17")).toBe(5);
    const [path, body, opts] = blob.put.mock.calls[0]!;
    expect(path).toBe("counters/bench/2026-10-17.json");
    expect(JSON.parse(body as string).n).toBe(5);
    expect(opts).toMatchObject({ access: "private", token: "tok", contentType: "application/json", addRandomSuffix: false, allowOverwrite: true });
    blob.get.mockRejectedValueOnce(new Error("503"));
    await expect(c.incr("bench", "2026-10-17")).rejects.toThrow("503");
    expect(blob.put).toHaveBeenCalledTimes(1);
  });

  it("RedisDailyCounter: missing and non-numeric values read as 0, an invalid day throws", async () => {
    const r = new FakeRedis();
    const c = new RedisDailyCounter(r, "p/");
    expect(await c.get("public", "2026-10-17")).toBe(0);
    r.strings.set("p/counters/public/2026-10-17", "abc");
    expect(await c.get("public", "2026-10-17")).toBe(0);
    r.strings.set("p/counters/public/2026-10-17", "9");
    expect(await c.get("public", "2026-10-17")).toBe(9);
    expect(await c.incr("public", "2026-10-17")).toBe(10);
    await expect(c.get("public", "bad")).rejects.toThrow("invalid day");
  });

  it("refused() without a message falls back to 'rate limited'", async () => {
    const d: Decision = { ok: false, ns: "judge", status: 429, headers: { "x-a": "1" } };
    const res = refused(d);
    expect(res.status).toBe(429);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({ error: "rate limited", namespace: "judge", receipts: "/integrations/qloo" });
  });
});
