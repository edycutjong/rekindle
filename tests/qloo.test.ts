import { describe, expect, it, vi } from "vitest";
import { QlooClient, QlooError, countResults, encodeParams, type QlooCallLog } from "../lib/qloo";

const KEY = "test-key-never-logged";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function client(responses: (Response | Error)[], logs: QlooCallLog[] = []) {
  const fetchImpl = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    if (next instanceof Error) throw next;
    return next;
  });
  const sleep = vi.fn(async () => {});
  const c = new QlooClient({ apiKey: KEY, fetchImpl: fetchImpl as unknown as typeof fetch, onCall: (l) => logs.push(l), sleep, random: () => 0.5 });
  return { c, fetchImpl, sleep, logs };
}

describe("lib/qloo", () => {
  it("encodes arrays comma-joined, booleans as strings, and drops empty values", () => {
    expect(encodeParams({ a: ["x", "y"], b: true, c: 0, d: undefined, e: null, f: "", g: [] })).toEqual({ a: "x,y", b: "true", c: "0" });
  });

  it("counts results across insights, tags, heatmap and search shapes", () => {
    expect(countResults({ results: { entities: [1, 2] } })).toBe(2);
    expect(countResults({ results: { tags: [1] } })).toBe(1);
    expect(countResults({ results: { heatmap: [1, 2, 3] } })).toBe(3);
    expect(countResults({ results: [1, 2, 3, 4] })).toBe(4);
    expect(countResults(null)).toBe(0);
  });

  it("refuses any base URL other than the hackathon host (other hosts 401 hackathon keys)", () => {
    expect(() => new QlooClient({ apiKey: KEY, baseUrl: "https://api.qloo.com" })).toThrow(/hackathon\.api\.qloo\.com/);
    expect(() => new QlooClient({ apiKey: "" })).toThrow(/QLOO_API_KEY/);
  });

  it("sends GET with the X-Api-Key header and logs the call without the key", async () => {
    const { c, fetchImpl, logs } = client([json(200, { results: { entities: [{ entity_id: "a" }] } })]);
    await c.insights({ "filter.type": "urn:entity:place", take: 3 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://hackathon.api.qloo.com/v2/insights?filter.type=urn%3Aentity%3Aplace&take=3");
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>)["X-Api-Key"]).toBe(KEY);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ path: "/v2/insights", status: 200, n_results: 1, attempts: 1 });
    expect(JSON.stringify(logs)).not.toContain(KEY);
  });

  it("retries once, with jitter, on 429/5xx and then succeeds", async () => {
    const { c, fetchImpl, sleep, logs } = client([json(503, { error: "busy" }), json(200, { results: { tags: [{ id: "t" }] } })]);
    const r = await c.tags("ramen");
    expect(r.results.tags).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(500);
    expect(logs[0].attempts).toBe(2);
  });

  it("does not retry a 400 and throws a QlooError carrying the status", async () => {
    const { c, fetchImpl, logs } = client([json(400, { error: 'output.heatmap.boundary must be "urn:geohash"' })]);
    await expect(c.insights({ "filter.type": "urn:heatmap" })).rejects.toMatchObject({ name: "QlooError", status: 400 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(logs[0]).toMatchObject({ status: 400, n_results: 0 });
    expect(logs[0].error).toContain("urn:geohash");
  });

  it("gives up after the single retry on a persistent 500 (slot is left empty upstream)", async () => {
    const { c, fetchImpl } = client([json(500, "System Error"), json(500, "System Error")]);
    const err = await c.insights({}).catch((e) => e);
    expect(err).toBeInstanceOf(QlooError);
    expect(err.status).toBe(500);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("treats a network error or timeout as retryable", async () => {
    const { c, fetchImpl } = client([new DOMException("The operation was aborted due to timeout", "TimeoutError"), json(200, { results: [] })]);
    await expect(c.search("Fleabag", { types: ["urn:entity:tv_show"] })).resolves.toEqual({ results: [] });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
