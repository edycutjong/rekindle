import { describe, expect, it } from "vitest";
import { checkHealth, probeLlm, probeQloo, probeStore, resetHealthCache } from "../lib/health";
import { makeLlm } from "../lib/llm";
import { QlooClient } from "../lib/qloo";

const qloo = (status: number) =>
  new QlooClient({
    apiKey: "secret-key-never-shown",
    fetchImpl: (async () => new Response(JSON.stringify({ results: { tags: [{ id: "urn:tag:genre:place:bakery", name: "Bakery" }] } }), { status })) as unknown as typeof fetch,
    sleep: async () => {},
  });
const chat = (ok: boolean) =>
  (async () =>
    ok
      ? Response.json({ id: "x", object: "chat.completion", created: 1, model: "m", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })
      : new Response("{}", { status: 400 })) as unknown as typeof fetch;

describe("/api/health (lib/health.ts)", () => {
  it("Qloo probe: one /v2/tags call; a failure reports status, never the key", async () => {
    expect(await probeQloo(qloo(200))).toMatchObject({ ok: true });
    const bad = await probeQloo(qloo(401));
    expect(bad.ok).toBe(false);
    expect(JSON.stringify(bad)).not.toContain("secret-key-never-shown");
  });

  it("LLM probe falls over to the second provider, and reports none configured", async () => {
    const r = await probeLlm([makeLlm("qwen", { QWEN_API_KEY: "k" }, chat(false))!, makeLlm("groq", { GROQ_API_KEY: "k" }, chat(true))!]);
    expect(r).toMatchObject({ ok: true, provider: "groq" });
    expect(r.detail).toMatch(/fallback/);
    expect(await probeLlm([])).toMatchObject({ ok: false, detail: "no LLM key configured" });
  });

  it("caches for 60 s per instance so a pinger cannot spend the keys", async () => {
    resetHealthCache();
    let n = 0;
    const deps = { qloo: () => (n++, qloo(200)), llms: () => [makeLlm("qwen", { QWEN_API_KEY: "k" }, chat(true))!], store: "memory" };
    const a = await checkHealth(deps, 1_000);
    const b = await checkHealth(deps, 30_000);
    const c = await checkHealth(deps, 62_000);
    expect([a.ok, a.cached, b.cached, c.cached]).toEqual([true, false, true, false]);
    expect(n).toBe(2);
    resetHealthCache();
  });

  it("QA round 4 (a2a r01): the Blob store is probed — a 404 means it answered, a suspended store fails health (an uptime pinger can see a quota lockout)", async () => {
    const { BlobNotFoundError, BlobStoreSuspendedError } = await import("@vercel/blob");
    expect((await probeStore(undefined)).detail).toBe("in-memory store");
    expect((await probeStore("tok", async () => { throw new BlobNotFoundError(); })).ok).toBe(true);
    const down = await probeStore("tok", async () => { throw new BlobStoreSuspendedError(); });
    expect(down.ok).toBe(false);
    expect(down.detail).not.toContain("tok");
    resetHealthCache();
    const ok = { ok: true, ms: 1, detail: "x" };
    const h = await checkHealth({ qloo: () => ({ tags: async () => ({ results: { tags: [{}] } }) }) as never, llms: () => [], store: "blob", probeStore: async () => ({ ...ok, ok: false }) }, 5_000_000);
    expect(h.storeProbe.ok).toBe(false);
    expect(h.ok).toBe(false);
    resetHealthCache();
  });

  it("QA round 4 (a2a r02): the Blob probe runs only on a deep check, and a deep result never answers a shallow one", async () => {
    resetHealthCache();
    let probes = 0;
    const deps = { qloo: () => ({ tags: async () => ({ results: { tags: [{}] } }) }) as never, llms: () => [], store: "blob" };
    const deepDeps = { ...deps, probeStore: async () => (probes++, { ok: true, ms: 1, detail: "blob store reachable" }) };
    const shallow = await checkHealth(deps, 9_000_000);
    expect(probes).toBe(0);
    expect(shallow.storeProbe.detail).toMatch(/not probed/);
    const deep = await checkHealth(deepDeps, 9_000_001);
    expect(probes).toBe(1);
    expect(deep.cached).toBe(false);
    const again = await checkHealth(deps, 9_000_002);
    expect(again.storeProbe.detail).toMatch(/not probed/); // the deep entry did not answer
    expect(probes).toBe(1);
    resetHealthCache();
  });
});
