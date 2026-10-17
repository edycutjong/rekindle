import { afterEach, describe, expect, it, vi } from "vitest";
import { QlooClient, QlooError, countResults, qlooFromEnv, retryAfterMs, type QlooCallLog } from "../lib/qloo";

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("cov-d qloo", () => {
  it("countResults: object results without a known array, and a missing results key, count 0", () => {
    expect(countResults({ results: { other: [1] } })).toBe(0);
    expect(countResults({ results: { entities: "x", tags: [1, 2] } })).toBe(2);
    expect(countResults({})).toBe(0);
    expect(countResults({ results: 5 })).toBe(0);
  });

  it("retryAfterMs: seconds, HTTP date, garbage, empty, and the cap", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    expect(retryAfterMs(null)).toBeNull();
    expect(retryAfterMs("")).toBeNull();
    expect(retryAfterMs("2")).toBe(2000);
    expect(retryAfterMs("-5")).toBe(0);
    expect(retryAfterMs("99")).toBe(3000);
    expect(retryAfterMs("Thu, 01 Jan 2026 00:00:02 GMT")).toBe(2000);
    expect(retryAfterMs("Thu, 01 Jan 2026 00:10:00 GMT")).toBe(3000);
    expect(retryAfterMs("Wed, 31 Dec 2025 23:00:00 GMT")).toBe(0);
    expect(retryAfterMs("not a date")).toBeNull();
  });

  it("uses the default sleep and random: a 500 then a 200 succeeds on attempt 2", async () => {
    const logs: QlooCallLog[] = [];
    const responses = [json(500, {}), json(200, { results: [1] })];
    const c = new QlooClient({ apiKey: "k", fetchImpl: (async () => responses.shift()!) as unknown as typeof fetch, onCall: (l) => logs.push(l) });
    vi.useFakeTimers();
    const p = c.get("/x");
    await vi.advanceTimersByTimeAsync(2000);
    expect(await p).toEqual({ results: [1] });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ status: 200, attempts: 2, n_results: 1 });
  });

  it("honours an HTTP-date Retry-After and survives an unreadable error body and non-Error throws", async () => {
    const logs: QlooCallLog[] = [];
    const bad = json(500, {});
    bad.text = () => Promise.reject(new Error("body gone"));
    const responses: (Response | unknown)[] = [bad, "plain string failure"];
    const sleep = vi.fn(async () => {});
    const c = new QlooClient({ apiKey: "k", fetchImpl: (async () => {
      const r = responses.shift();
      if (r instanceof Response) return r;
      throw r;
    }) as unknown as typeof fetch, onCall: (l) => logs.push(l), sleep, random: () => 0 });
    await expect(c.get("/y")).rejects.toMatchObject({ name: "QlooError", status: 0 });
    expect(logs[0]).toMatchObject({ status: 0, attempts: 2, error: "plain string failure" });
    expect(sleep).toHaveBeenCalledWith(250);
  });

  it("429 with a past HTTP-date Retry-After retries immediately and then succeeds", async () => {
    const responses = [json(429, {}, { "retry-after": "Wed, 31 Dec 2025 23:00:00 GMT" }), json(200, { results: [] })];
    const sleep = vi.fn(async () => {});
    const c = new QlooClient({ apiKey: "k", fetchImpl: (async () => responses.shift()!) as unknown as typeof fetch, sleep, random: () => 0 });
    expect(await c.get("/z")).toEqual({ results: [] });
    expect(sleep).toHaveBeenCalledWith(0);
  });

  it("qlooFromEnv: reads QLOO_API_KEY and an optional QLOO_BASE_URL; a missing key throws", () => {
    vi.stubEnv("QLOO_API_KEY", undefined);
    vi.stubEnv("QLOO_BASE_URL", "");
    expect(() => qlooFromEnv()).toThrow(/QLOO_API_KEY/);
    vi.stubEnv("QLOO_API_KEY", "");
    expect(() => qlooFromEnv()).toThrow(/QLOO_API_KEY/);
    vi.stubEnv("QLOO_API_KEY", "abc");
    expect(qlooFromEnv(undefined, { deadline: Date.now() + 1000 })).toBeInstanceOf(QlooClient);
    vi.stubEnv("QLOO_BASE_URL", "https://hackathon.api.qloo.com/");
    expect(qlooFromEnv()).toBeInstanceOf(QlooClient);
    vi.stubEnv("QLOO_BASE_URL", "https://evil.example.com");
    expect(() => qlooFromEnv()).toThrow(/must be/);
  });

  it("QlooError carries status and path", () => {
    const e = new QlooError("m", 401, "/p");
    expect([e.status, e.path, e.name]).toEqual([401, "/p", "QlooError"]);
  });
});
