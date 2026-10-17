/** Coverage group a: GET /api/health — which backend it names and probes, the deep flag, the limiter, and the 200/503 verdict. No network. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetHealthCache } from "../lib/health";
import { limiterFromEnv } from "../lib/ratelimit";
import { resetFailover } from "../lib/store";

const blob = vi.hoisted(() => ({ head: vi.fn() }));
vi.mock("@vercel/blob", async (orig) => ({ ...(await orig<typeof import("@vercel/blob")>()), head: blob.head }));

import { GET } from "../app/api/health/route";

let n = 0;
const get = (url = "/api/health", ip = `11.0.0.${++n}`) => GET(new Request(`http://x${url}`, { headers: { "x-forwarded-for": ip } }));
const json = async (r: Response) => (await r.json()) as { ok: boolean; store: string; storeDegraded: boolean; qloo: { ok: boolean }; llm: { ok: boolean; provider: string | null }; storeProbe: { ok: boolean; detail: string } };

const llmOk = () =>
  Response.json({ id: "x", object: "chat.completion", created: 1, model: "m", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
/** answers Qloo tags, the Qwen chat call and Upstash PING; records what was asked */
function stubNetwork(o: { llm?: boolean; seen?: string[] } = {}) {
  vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    o.seen?.push(new URL(url).host + new URL(url).pathname);
    if (url.includes("qloo.com")) return Response.json({ results: { tags: [{ id: "urn:tag:genre:place:bakery", name: "Bakery" }] } });
    if (url.includes("dashscope")) return o.llm === false ? new Response("{}", { status: 400 }) : llmOk();
    if (url.includes("upstash.test")) {
      // Upstash replies base64; the client batches even one command into /pipeline
      const reply = (cmd: string[]) => ({ result: Buffer.from(cmd[0]!.toLowerCase() === "ping" ? "PONG" : "OK").toString("base64") });
      const cmds = JSON.parse(String(init?.body ?? "[]")) as string[] | string[][];
      return Response.json(Array.isArray(cmds[0]) ? (cmds as string[][]).map(reply) : reply(cmds as string[]));
    }
    throw new Error(`unexpected request ${url}`);
  });
}

beforeEach(() => {
  resetHealthCache();
  resetFailover();
  for (const k of ["BLOB_READ_WRITE_TOKEN", "KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "VERCEL", "STORE_BACKEND", "STORE_FAULT", "GROQ_API_KEY"]) vi.stubEnv(k, "");
  vi.stubEnv("QLOO_API_KEY", "qloo-key");
  vi.stubEnv("QWEN_API_KEY", "qwen-key");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  blob.head.mockReset();
  resetFailover();
});

describe("GET /api/health", () => {
  it("shallow: 200 when Qloo and the LLM answer, the store named but not probed; a second hit is the cached verdict", async () => {
    const seen: string[] = [];
    stubNetwork({ seen });
    const r = await get();
    expect(r.status).toBe(200);
    expect(await json(r)).toMatchObject({ ok: true, store: "memory", storeDegraded: false, storeProbe: { ok: true, detail: expect.stringMatching(/not probed/) } });
    expect(seen.some((s) => s.includes("qloo.com/v2/tags"))).toBe(true);
    const before = seen.length;
    expect(((await (await get()).json()) as { cached: boolean }).cached).toBe(true);
    expect(seen).toHaveLength(before);
  });

  it("503 when the LLM does not answer", async () => {
    stubNetwork({ llm: false });
    const r = await get();
    expect(r.status).toBe(503);
    expect(await json(r)).toMatchObject({ ok: false, qloo: { ok: true }, llm: { ok: false, provider: null } });
  });

  it("deep on Redis: one PING, no Blob call; the store is named `redis`", async () => {
    vi.stubEnv("KV_REST_API_URL", "https://upstash.test");
    vi.stubEnv("KV_REST_API_TOKEN", "tok");
    const seen: string[] = [];
    stubNetwork({ seen });
    const r = await get("/api/health?deep=1");
    expect(r.status).toBe(200);
    expect(await json(r)).toMatchObject({ store: "redis", storeProbe: { ok: true, detail: "redis PING → PONG" } });
    expect(seen.some((s) => s.startsWith("upstash.test"))).toBe(true);
    expect(blob.head).not.toHaveBeenCalled();
  });

  it("deep on Blob: one head() on a path that need not exist; a 404 means the store answered", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "vercel_blob_rw_test");
    const { BlobNotFoundError } = await import("@vercel/blob");
    blob.head.mockRejectedValue(new BlobNotFoundError());
    stubNetwork();
    const r = await get("/api/health?deep=1");
    expect(r.status).toBe(200);
    expect(await json(r)).toMatchObject({ store: "blob", storeProbe: { ok: true, detail: "blob store reachable" } });
    expect(blob.head).toHaveBeenCalledWith("health/ping.json", { token: "vercel_blob_rw_test" });
  });

  it("deep on a deployment with no store: reported as `none` and unhealthy (503), never a crash", async () => {
    vi.stubEnv("VERCEL", "1");
    stubNetwork();
    const r = await get("/api/health?deep=1");
    expect(r.status).toBe(503);
    expect(await json(r)).toMatchObject({ ok: false, store: "none", storeProbe: { ok: false, detail: "no store configured on this deployment" } });
  });

  it("is refused once an address has used its 30 health checks in the hour", async () => {
    stubNetwork();
    const ip = "11.9.9.9";
    for (let i = 0; i < 30; i++) limiterFromEnv().window.hit(`public:health:${ip}`, 30);
    const r = await get("/api/health", ip);
    expect(r.status).toBe(429);
    expect(await r.json()).toMatchObject({ namespace: "public", reason: "ip" });
  });
});
