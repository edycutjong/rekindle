/** Coverage group a: lib/{health,http,intake,judge,llm,owner,reads,receipts,receipts-cached,redact,replan,resolve}. No network. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkHealth, probeLlm, probeQloo, probeRedis, probeStore, resetHealthCache } from "../lib/health";
import { parseSse, sseResponse } from "../lib/http";
import { BadInput, checkLoveShapes, verifyLoves, type LoveIn } from "../lib/intake";
import { ARM_LABEL, benchReceipt, benchRows, type AuditResults, type BenchResults } from "../lib/judge";
import { llmChainFromEnv, makeLlm } from "../lib/llm";
import { assertCaseOwner, assertPlanOwner, canWrite, Forbidden, ownerForNewCase, ownerHash } from "../lib/owner";
import { gatedRead, pageGate, readCase, readDoc, readPlan } from "../lib/reads";
import { cachedLatestReceipts, receiptsError, RECEIPTS_TAG } from "../lib/receipts-cached";
import { countRules, distinctRefusals, latestReceipts, percentile, resetReceiptsCache, summarise, type PlanReceipt } from "../lib/receipts";
import { providerError, redactAccountIds } from "../lib/redact";
import { diffWeeks, emberLead, explainMargin, historyFromRatings, keptCandidate, seedRatings, specificGenreTags, type KeptNote } from "../lib/replan";
import { LOVE_KINDS, rankTags, resolveLove, screenLoveText } from "../lib/resolve";
import { QlooError, type QlooClient } from "../lib/qloo";
import { NotFound, caseFromSeed } from "../lib/service";
import { MemoryStore, StoreUnavailable, type PlanDoc, type Store } from "../lib/store";
import type { Card, PlanHistory, WeekPlan } from "../lib/plan";

// the Blob SDK head() and next/headers + next/cache are stubbed: nothing here may reach the network or need a request scope
const blob = vi.hoisted(() => ({ head: vi.fn() }));
vi.mock("@vercel/blob", async (orig) => ({ ...(await orig<typeof import("@vercel/blob")>()), head: blob.head }));
const hdr = vi.hoisted(() => ({ h: new Headers() }));
vi.mock("next/headers", () => ({ headers: async () => hdr.h }));
const nextCache = vi.hoisted(() => ({ calls: [] as { keys: string[]; opts: { revalidate?: number; tags?: string[] } }[] }));
vi.mock("next/cache", () => ({
  unstable_cache: (fn: () => unknown, keys: string[], opts: { revalidate?: number; tags?: string[] }) => {
    nextCache.calls.push({ keys, opts });
    return fn;
  },
}));
const compat = vi.hoisted(() => ({ settings: [] as { name: string; transformRequestBody?: (b: Record<string, unknown>) => Record<string, unknown> }[] }));
vi.mock("@ai-sdk/openai-compatible", async (orig) => {
  const m = await orig<typeof import("@ai-sdk/openai-compatible")>();
  return {
    ...m,
    createOpenAICompatible: (s: Parameters<typeof m.createOpenAICompatible>[0]) => {
      compat.settings.push(s as never);
      return m.createOpenAICompatible(s);
    },
  };
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetHealthCache();
  resetReceiptsCache();
  blob.head.mockReset();
});

const failingFetch = (async () => new Response("{}", { status: 400 })) as unknown as typeof fetch;

describe("lib/health.ts", () => {
  const tagsClient = (tags: () => Promise<unknown>) => ({ tags }) as unknown as QlooClient;

  it("probeQloo: an empty or missing tags payload is not ok; a non-Error rejection is reported as text", async () => {
    for (const payload of [undefined, {}, { results: {} }, { results: { tags: [] } }]) {
      expect(await probeQloo(tagsClient(async () => payload))).toMatchObject({ ok: false, detail: "/v2/tags returned no tags" });
    }
    expect(await probeQloo(tagsClient(async () => ({ results: { tags: [{ id: "t" }] } })))).toMatchObject({ ok: true, detail: "/v2/tags → 1 tag" });
    const bad = await probeQloo(tagsClient(() => Promise.reject("plain  string\nfailure")));
    expect(bad).toMatchObject({ ok: false, detail: "plain string failure" });
  });

  it("probeLlm: every provider failing reports each error and no provider", async () => {
    const chain = [makeLlm("qwen", { QWEN_API_KEY: "k" }, failingFetch)!, makeLlm("groq", { GROQ_API_KEY: "k" }, failingFetch)!];
    const r = await probeLlm(chain);
    expect(r).toMatchObject({ ok: false, provider: null, model: null });
    expect(r.detail).toMatch(/^qwen: .*; groq: /);
  });

  it("probeStore: no token is the in-memory store; a Blob 404 means reachable; any other failure is reported", async () => {
    expect(await probeStore(undefined)).toMatchObject({ ok: true, detail: "in-memory store" });
    const { BlobNotFoundError } = await import("@vercel/blob");
    // default head() = the (stubbed) SDK call
    blob.head.mockRejectedValueOnce(new BlobNotFoundError());
    expect(await probeStore("tok")).toMatchObject({ ok: true, detail: "blob store reachable" });
    blob.head.mockResolvedValueOnce({});
    expect(await probeStore("tok")).toMatchObject({ ok: true });
    expect(blob.head).toHaveBeenCalledWith("health/ping.json", { token: "tok" });
    blob.head.mockRejectedValueOnce(new Error("store suspended"));
    expect(await probeStore("tok")).toMatchObject({ ok: false, detail: "store suspended" });
    // an injected head() bypasses the SDK
    const head = vi.fn(async () => ({}));
    expect(await probeStore("tok", head)).toMatchObject({ ok: true });
    expect(head).toHaveBeenCalledOnce();
    expect(await probeStore("tok", async () => Promise.reject(new TypeError("boom")))).toMatchObject({ ok: false, detail: "boom" });
  });

  it("probeRedis: PONG is ok (any case), anything else or a throw is not", async () => {
    expect(await probeRedis(async () => "pong")).toMatchObject({ ok: true, detail: "redis PING → pong" });
    expect(await probeRedis(async () => "NOPE")).toMatchObject({ ok: false });
    expect(await probeRedis(async () => Promise.reject(new Error("quota")))).toMatchObject({ ok: false, detail: "quota" });
  });

  it("checkHealth: a throwing Qloo factory is a failed probe, and the result is cached by depth", async () => {
    const deps = { qloo: () => Promise.reject() as never, llms: () => [], store: "memory" };
    const boom = {
      ...deps,
      qloo: () => {
        throw new Error("QLOO_API_KEY missing");
      },
    };
    const h = await checkHealth(boom, 1_000);
    expect(h).toMatchObject({ ok: false, cached: false, qloo: { ok: false, ms: 0, detail: "QLOO_API_KEY missing" }, storeProbe: { ok: true } });
    expect((await checkHealth(boom, 2_000)).cached).toBe(true);
    // a deep request is never answered by the shallow entry
    const deep = await checkHealth({ ...boom, probeStore: async () => ({ ok: false, ms: 1, detail: "down" }) }, 3_000);
    expect(deep).toMatchObject({ cached: false, storeProbe: { ok: false, detail: "down" } });
  });
});

describe("lib/http.ts", () => {
  it("parseSse: a frame without an event line is `message`, one without data has null data", () => {
    expect(parseSse('data: {"a":1}\n\nevent: ping\n\nevent: x\ndata: [2]\n\n')).toEqual([
      { event: "message", data: { a: 1 } },
      { event: "ping", data: null },
      { event: "x", data: [2] },
    ]);
  });

  it("sseResponse: a client that went away does not stop the run, later sends are dropped, and nothing throws", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let finished = false;
    const sent: string[] = [];
    const res = sseResponse(async (send) => {
      await gate;
      send("late", { n: 1 }); // the reader is gone: enqueue throws, the stream marks itself closed
      send("later", { n: 2 }); // dropped silently
      sent.push("after-sends");
      finished = true;
    });
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toMatch(/^event: open\n/);
    await reader.cancel();
    release();
    await vi.waitFor(() => expect(finished).toBe(true));
    expect(sent).toEqual(["after-sends"]);
  });

  it("sseResponse: a run that throws ends the stream with an error frame carrying the mapped status", async () => {
    const res = sseResponse(async () => {
      throw new NotFound("gone");
    });
    const frames = parseSse(await res.text());
    expect(frames.map((f) => f.event)).toEqual(["open", "error"]);
    expect(frames[1]!.data).toMatchObject({ status: 404, error: "gone" });
  });
});

describe("lib/intake.ts", () => {
  const ID = (n: number) => `0000000${n}-0000-4000-8000-000000000000`;
  const entity = (n: number, extra: Partial<LoveIn> = {}): LoveIn => ({ text: `love ${n}`, qloo_id: ID(n), qloo_kind: "entity", ...extra });
  const tag = (n: number): LoveIn => ({ text: `tag ${n}`, qloo_id: `urn:tag:genre:place:restaurant:t${n}`, qloo_kind: "tag" });
  const qloo = (o: { entities?: () => Promise<unknown>; tags?: (q: string) => Promise<unknown> }) => o as unknown as QlooClient;

  it("checkLoveShapes: duplicates (case-insensitive), bad ids per kind, unsupported entity types and screened text are BadInput", () => {
    const cases: [LoveIn[], RegExp][] = [
      [[entity(1), { ...entity(1), qloo_id: ID(1).toUpperCase() }], /different Qloo entity or tag/],
      [[{ ...entity(1), qloo_id: "nope" }], /does not carry a Qloo entity ID/],
      [[{ ...tag(1), qloo_id: "urn:entity:artist" }], /does not carry a Qloo tag ID/],
      [[entity(1, { entity_type: "urn:entity:spaceship" })], /unsupported entity type/],
      [[{ ...entity(1), text: "PHQ-9 score" }], /health information/],
    ];
    for (const [loves, msg] of cases) expect(() => checkLoveShapes(loves), msg.source).toThrow(msg);
    for (const [loves] of cases) expect(() => checkLoveShapes(loves)).toThrow(BadInput);
    expect(() => checkLoveShapes([entity(1, { entity_type: "urn:entity:artist" }), tag(2)])).not.toThrow();
  });

  it("verifyLoves: Qloo's name and a confirmed type are stored; the type falls back to Qloo's own when the client's is wrong", async () => {
    const q = qloo({
      entities: async () => ({
        results: [
          { entity_id: ID(1).toUpperCase(), name: "Qloo One", types: ["urn:entity:artist"] },
          { entity_id: ID(2), name: "Qloo Two", type: "urn:entity:movie" }, // single `type`, no `types`
          { entity_id: ID(3), name: "Qloo Three", types: ["urn:entity:place", "urn:entity:book"] },
          { entity_id: ID(4), name: "Qloo Four" }, // no types at all
          { entity_id: ID(5), name: "Qloo Five", types: ["urn:entity:place"] }, // nothing in the love-kind set
        ],
      }),
    });
    const out = await verifyLoves(q, [
      entity(1, { entity_type: "urn:entity:artist" }),
      entity(2),
      entity(3, { entity_type: "urn:entity:tv_show" }), // not among Qloo's types → first supported Qloo type
      entity(4, { entity_type: "urn:entity:podcast" }), // Qloo lists none → the claim is kept
      entity(5),
    ]);
    expect(out).toEqual([
      { text: "love 1", qloo_id: ID(1), qloo_kind: "entity", entity_type: "urn:entity:artist", name: "Qloo One" },
      { text: "love 2", qloo_id: ID(2), qloo_kind: "entity", entity_type: "urn:entity:movie", name: "Qloo Two" },
      { text: "love 3", qloo_id: ID(3), qloo_kind: "entity", entity_type: "urn:entity:book", name: "Qloo Three" },
      { text: "love 4", qloo_id: ID(4), qloo_kind: "entity", entity_type: "urn:entity:podcast", name: "Qloo Four" },
      { text: "love 5", qloo_id: ID(5), qloo_kind: "entity", name: "Qloo Five" },
    ]);
  });

  it("verifyLoves: a Qloo 400 is BadInput, other failures propagate, an unknown entity or tag is BadInput; missing results are empty", async () => {
    await expect(verifyLoves(qloo({ entities: () => Promise.reject(new QlooError("bad", 400, "/entities")) }), [entity(1)])).rejects.toThrow(/refused one of the confirmed entity IDs/);
    const e500 = new QlooError("down", 500, "/entities");
    await expect(verifyLoves(qloo({ entities: () => Promise.reject(e500) }), [entity(1)])).rejects.toBe(e500);
    const plain = new Error("network");
    await expect(verifyLoves(qloo({ entities: () => Promise.reject(plain) }), [entity(1)])).rejects.toBe(plain);
    await expect(verifyLoves(qloo({ entities: async () => ({}) }), [entity(1)])).rejects.toThrow(/does not know the entity/);
    // tags: no `results`, no tags, or a different id → not confirmed
    for (const payload of [{}, { results: {} }, { results: { tags: [{ name: "has no id at all" }, { id: "urn:tag:genre:place:restaurant:other" }] } }]) {
      await expect(verifyLoves(qloo({ tags: async () => payload }), [tag(1)])).rejects.toThrow(/does not return the tag confirmed for "tag 1"/);
    }
  });

  it("verifyLoves: tags match by id or tag_id (any case); the stored name is Qloo's, else the typed text", async () => {
    const asked: string[] = [];
    const q = qloo({
      tags: async (text) => {
        asked.push(text);
        return { results: { tags: [{ tag_id: "URN:TAG:GENRE:PLACE:RESTAURANT:T1", name: "Qloo Tag" }, { id: "urn:tag:genre:place:restaurant:t2" }, { name: "no id at all" }] } };
      },
    });
    const out = await verifyLoves(q, [tag(1), tag(2)]);
    expect(out).toEqual([
      { text: "tag 1", qloo_id: "urn:tag:genre:place:restaurant:t1", qloo_kind: "tag", name: "Qloo Tag" },
      { text: "tag 2", qloo_id: "urn:tag:genre:place:restaurant:t2", qloo_kind: "tag", name: "tag 2" },
    ]);
    expect(asked).toEqual(["tag 1", "tag 2"]);
  });
});

describe("lib/judge.ts", () => {
  const arm = (o: Partial<BenchResults["arms"][string]> = {}) => ({ outing_venues: 10, errors: 0, violation: 3, violation_rate: 0.3, unverifiable: 2, closed_at_slot: 1, alcohol: 0, alcohol_denominator: 5, unknown_hours: 1, ...o });
  const bench = { arms: { A: arm(), B: arm(), "B-": arm(), "B-4": arm(), "B-sym": arm(), Z: arm() } } as unknown as BenchResults;

  it("benchRows: every ordered arm has a label; audited text covers audited, unaudited A/B and the rest", () => {
    const audit = { arms: { "B-": { checked: 10, violations: 1, inconclusive: 0, rate: 0.1 }, A: { checked: 4, violations: 2, inconclusive: 1, rate: 0.5 } } } as unknown as AuditResults;
    const rows = benchRows(bench, audit);
    expect(rows.map((r) => r.arm)).toEqual(["A", "B", "B-sym", "B-", "B-4"]); // Z is not a known arm
    expect(rows.every((r) => r.label === ARM_LABEL[r.arm])).toBe(true);
    expect(rows.map((r) => r.audited)).toEqual(["50.0% (2/4, 1 inconclusive)", "not audited yet", "—", "10.0% (1/10)", "—"]);
  });

  it("benchReceipt: sums per-plan Qloo calls only when every plan recorded them", () => {
    const b = { finished_at: "2026-10-07T13:00:00+00:00", plans: [{ qloo_calls: 4 }, { qloo_calls: 0 }], errors: [] } as unknown as BenchResults;
    expect(benchReceipt(b)).toBe("bench run finished 2026-10-07 13:00 UTC · 2 Rekindle plans · 4 Qloo calls on the plan path · 0 errors");
    expect(benchReceipt({ ...b, plans: [{ qloo_calls: 4 }, {}] } as unknown as BenchResults)).not.toMatch(/Qloo calls/);
  });
});

describe("lib/llm.ts", () => {
  it("groq transformRequestBody drops reasoning_content from echoed messages and allows parallel tool calls", () => {
    compat.settings.length = 0;
    expect(makeLlm("groq", { GROQ_API_KEY: "k", GROQ_MODEL: "m1" }, failingFetch)).toMatchObject({ provider: "groq", modelId: "m1" });
    const groq = compat.settings.find((s) => s.name === "groq")!;
    const t = groq.transformRequestBody!;
    const out = t({
      model: "m1",
      tools: [{ type: "function" }],
      messages: [{ role: "assistant", content: "hi", reasoning_content: "secret thoughts" }, { role: "user", content: "q" }, null],
    });
    expect(out).toMatchObject({ parallel_tool_calls: true, messages: [{ role: "assistant", content: "hi" }, { role: "user", content: "q" }, null] });
    expect((out.messages as Record<string, unknown>[])[0]).not.toHaveProperty("reasoning_content");
    // no tools, and no message array: the body passes through untouched
    expect(t({ model: "m1" })).toEqual({ model: "m1" });
  });

  it("qwen sends thinking off always, parallel tool calls only with tools; the chain is primary first and skips unkeyed providers", () => {
    compat.settings.length = 0;
    const chain = llmChainFromEnv({ QWEN_API_KEY: "q", GROQ_API_KEY: "g", LLM_PROVIDER: "groq" }, failingFetch);
    expect(chain.map((h) => h.provider)).toEqual(["groq", "qwen"]);
    const qwen = compat.settings.find((s) => s.name === "qwen")!;
    expect(qwen.transformRequestBody!({ a: 1 })).toEqual({ a: 1, enable_thinking: false });
    expect(qwen.transformRequestBody!({ tools: [{}] })).toMatchObject({ enable_thinking: false, parallel_tool_calls: true });
    expect(llmChainFromEnv({ GROQ_API_KEY: "g" }).map((h) => h.provider)).toEqual(["groq"]);
    expect(llmChainFromEnv({})).toEqual([]);
  });
});

describe("lib/owner.ts", () => {
  const TOKEN = "owner-token-0123456789abcdef-ABCDEF";
  const req = (headers: Record<string, string> = {}) => ({ headers: new Headers(headers) });

  it("ownerForNewCase: a new browser gets a cookie (Secure only in production); an existing token is reused with no Set-Cookie", () => {
    const fresh = ownerForNewCase(req(), true);
    expect(fresh.setCookie["set-cookie"]).toMatch(/^rk_owner=[A-Za-z0-9_-]{32}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=31536000; Secure$/);
    expect(ownerForNewCase(req(), false).setCookie["set-cookie"]).not.toMatch(/Secure/);
    expect(ownerForNewCase(req()).setCookie["set-cookie"]).not.toMatch(/Secure/); // NODE_ENV is "test"
    const again = ownerForNewCase(req({ cookie: `rk_owner=${TOKEN}` }), true);
    expect(again).toEqual({ owner_hash: ownerHash(TOKEN), setCookie: {} });
  });

  it("canWrite: the bench token always may; otherwise only the cookie whose hash is on the case", () => {
    const env = { BENCH_TOKEN: "bench-token-0123456789" };
    expect(canWrite(req({ "x-bench-token": "bench-token-0123456789" }), { owner_hash: undefined }, env)).toBe(true);
    expect(canWrite(req({ cookie: `rk_owner=${TOKEN}` }), { owner_hash: ownerHash(TOKEN) }, env)).toBe(true);
    expect(canWrite(req({ cookie: `rk_owner=${TOKEN}` }), { owner_hash: ownerHash("another-token-0123456789abcdef-XYZ") }, env)).toBe(false);
    expect(canWrite(req({ cookie: `rk_owner=${TOKEN}` }), { owner_hash: undefined }, env)).toBe(false);
    expect(canWrite(req(), { owner_hash: ownerHash(TOKEN) }, env)).toBe(false);
    expect(canWrite(req({ cookie: "rk_owner=short" }), { owner_hash: ownerHash("short") }, env)).toBe(false);
  });

  it("assertPlanOwner / assertCaseOwner: a missing plan or case is NotFound (fail closed), a foreign case is Forbidden", async () => {
    const store = new MemoryStore();
    const c = { ...caseFromSeed("maya")!, owner_hash: ownerHash(TOKEN) };
    await store.putCase(c);
    const id = crypto.randomUUID();
    await expect(assertCaseOwner(req(), store, id)).rejects.toBeInstanceOf(NotFound);
    await expect(assertCaseOwner(req(), store, c.id)).rejects.toBeInstanceOf(Forbidden);
    expect(await assertCaseOwner(req({ cookie: `rk_owner=${TOKEN}` }), store, c.id)).toMatchObject({ id: c.id });
    await expect(assertPlanOwner(req(), store, id)).rejects.toThrow(`plan ${id} not found`);
    // a plan whose case is gone
    const orphan = { id, case_id: crypto.randomUUID() } as unknown as PlanDoc;
    const stub = { getPlan: async () => orphan, getCase: async () => null } as unknown as Store;
    await expect(assertPlanOwner(req(), stub, id)).rejects.toThrow(`case ${orphan.case_id} not found`);
  });
});

describe("lib/reads.ts", () => {
  it("gatedRead: a refused gate returns its message (or the default) and never reads", async () => {
    const f = vi.fn(async () => "doc");
    expect(await gatedRead(async () => ({ ok: false, message: "slow down" }) as never, f)).toEqual({ limited: "slow down" });
    expect(await gatedRead(async () => ({ ok: false }) as never, f)).toEqual({ limited: "Too many requests from this address. Try again later." });
    expect(f).not.toHaveBeenCalled();
    expect(await gatedRead(async () => ({ ok: true }) as never, f)).toEqual({ doc: "doc" });
  });

  it("readDoc: null is missing, StoreUnavailable is down, any other throw is missing", async () => {
    expect(await readDoc(async () => null)).toEqual({ missing: true });
    expect(await readDoc(async () => 1)).toEqual({ doc: 1 });
    expect(await readDoc(async () => Promise.reject(new StoreUnavailable()))).toEqual({ down: true });
    expect(await readDoc(async () => Promise.reject(new Error("invalid id")))).toEqual({ missing: true });
  });

  it("pageGate / readPlan / readCase: metered per IP from the request headers, then read from the store", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
    vi.stubEnv("KV_REST_API_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    vi.stubEnv("VERCEL", "");
    hdr.h = new Headers({ "x-forwarded-for": "7.7.7.7" });
    expect(await pageGate()).toMatchObject({ ok: true, ns: "public" });
    expect(await readPlan(crypto.randomUUID())).toEqual({ missing: true });
    expect(await readCase(crypto.randomUUID())).toEqual({ missing: true });
    expect(await readCase("../not-an-id")).toEqual({ missing: true }); // an invalid id is "missing", not a 500
    // a refused view reads nothing: exhaust this IP's `read` window
    vi.stubEnv("RL_PUBLIC_READS_PER_IP_HOUR", "0");
    hdr.h = new Headers({ "x-forwarded-for": "7.7.7.8" });
    const limited = await readPlan(crypto.randomUUID());
    expect(limited).toMatchObject({ limited: expect.stringMatching(/Too many requests/) });
  });
});

describe("lib/receipts.ts and lib/receipts-cached.ts", () => {
  const rec = (o: Partial<PlanReceipt["plan"]> & { calls?: PlanReceipt["calls"] }): PlanReceipt => {
    const { calls, ...plan } = o;
    return { plan: { id: "p", case_id: "c", week: 1, created_at: "t", llm_provider: null, llm_model: null, latency_ms: 1, origin: "agent", cards: 7, refusals: 0, refusals_by_rule: {}, review: 0, ...plan }, calls: calls ?? [] };
  };

  it("summarise: receipts cached before the agency/review fields still sum; only plans that carry the dial count toward it", () => {
    const old = rec({ refusals_by_rule: undefined as never, review: undefined as never });
    const fresh = rec({ model_routed: 5, model_coached: undefined, refusals_by_rule: { "R-OPEN": 2 }, review: 3 });
    const t = summarise([old, fresh, rec({ model_routed: 2, model_coached: 1, refusals_by_rule: { "R-OPEN": 1, "R-ALC": 1 } })]);
    expect(t.refusals_by_rule).toEqual({ "R-OPEN": 3, "R-ALC": 1 });
    expect(t.review).toBe(3);
    expect(t.agency).toEqual({ cards: 14, model_routed: 7, model_coached: 1 });
    expect(summarise([old]).agency).toEqual({ cards: 0, model_routed: 0, model_coached: 0 });
    expect(percentile([], 50)).toBeNull();
    expect(percentile([5, 1, 3], 50)).toBe(3);
    expect(countRules([{ rule: "a" }, { rule: "a" }, { rule: "b" }])).toEqual({ a: 2, b: 1 });
    const r = { rule: "R", qloo_entity_id: "e", day_name: "monday" as const };
    expect(distinctRefusals([r, { ...r }, { ...r, rule: "S" }])).toHaveLength(2);
  });

  it("latestReceipts: stops at the limit, skips replaced weeks in the list, tolerates a missing call log, and caches per key", async () => {
    const base = (await (async () => {
      const m = new MemoryStore();
      const c = caseFromSeed("maya")!;
      await m.putCase(c);
      return { c };
    })()).c;
    const mk = (id: string, o: Record<string, unknown> = {}) =>
      ({ id, case_id: base.id, week: 1, created_at: "2026-10-01T00:00:00Z", llm_provider: null, llm_model: null, latency_ms: 1, origin: "agent", cards: [{ routed_by: "llm", coaching_by: "llm" }, { routed_by: "fallback" }], refusals: [], review: [], fault: null, superseded_by: null, ...o }) as unknown as PlanDoc;
    const docs: Record<string, PlanDoc> = { a: mk("a"), b: mk("b", { superseded_by: "z" }), c: mk("c"), d: mk("d") };
    const reads: string[] = [];
    const store = {
      listPlanIds: async () => ["a", "b", "c", "d"],
      getPlan: async (id: string) => {
        reads.push(id);
        return docs[id] ?? null;
      },
      getCalls: async (id: string) => (id === "a" ? { plan_id: "a", calls: [{ path: "/v2/insights", params_json: {}, status: 200, ms: 10 }] } : null),
    } as unknown as Store;
    const r = await latestReceipts(store, { limit: 2 }, 1_000);
    expect(r.plans.map((p) => p.plan.id)).toEqual(["a", "c"]); // b (replaced) skipped, d never read
    expect(reads).toEqual(["a", "b", "c"]);
    expect(r.plans.map((p) => p.calls.length)).toEqual([1, 0]);
    expect(r.plans[0]!.plan).toMatchObject({ cards: 2, model_routed: 1, model_coached: 1 });
    expect(await latestReceipts(store, { limit: 2 }, 5_000)).toBe(r); // within 20 s: the cached object
    // one plan's receipts keep a replaced week (it was asked for by id)
    const one = await latestReceipts(store, { planId: "b" }, 1_000);
    expect(one.plans.map((p) => p.plan.id)).toEqual(["b"]);
  });

  it("latestReceipts: the per-instance cache is bounded (oldest key evicted past 32)", async () => {
    let listed = 0;
    const store = { listPlanIds: async () => (listed++, []), getPlan: async () => null, getCalls: async () => null } as unknown as Store;
    for (let limit = 1; limit <= 34; limit++) await latestReceipts(store, { limit }, 1_000);
    expect(listed).toBe(34);
    await latestReceipts(store, { limit: 34 }, 1_000); // newest key still cached
    expect(listed).toBe(34);
    await latestReceipts(store, { limit: 1 }, 1_000); // oldest key was evicted
    expect(listed).toBe(35);
  });

  it("receiptsError: a store outage reads as storage, other errors keep their message", () => {
    const outage = /storage is not answering right now/;
    expect(receiptsError(new StoreUnavailable())).toMatch(outage);
    const named = new Error("sdk says no");
    named.name = "StoreUnavailable";
    expect(receiptsError(named)).toMatch(outage);
    expect(receiptsError(new Error("plain"))).toBe("plain");
    expect(receiptsError("text")).toBe("text");
  });

  it("cachedLatestReceipts: keyed by shape version and limit, tagged, revalidated every RECEIPTS_TTL_S (default 900)", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
    vi.stubEnv("KV_REST_API_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    vi.stubEnv("VERCEL", "");
    nextCache.calls.length = 0;
    vi.stubEnv("RECEIPTS_TTL_S", "");
    delete process.env.RECEIPTS_TTL_S;
    const r = await cachedLatestReceipts();
    expect(r.plans).toEqual([]);
    expect(nextCache.calls[0]).toEqual({ keys: ["receipts-latest", "v2", "5"], opts: { revalidate: 900, tags: [RECEIPTS_TAG] } });
    vi.stubEnv("RECEIPTS_TTL_S", "60");
    await cachedLatestReceipts(3);
    expect(nextCache.calls[1]).toEqual({ keys: ["receipts-latest", "v2", "3"], opts: { revalidate: 60, tags: [RECEIPTS_TAG] } });
  });
});

describe("lib/redact.ts", () => {
  it("providerError: Error becomes `name: message`, anything else its text; account ids dropped; ≤ 300 chars", () => {
    expect(redactAccountIds("in organization `org_abc123` limit")).toBe("in organization `org_…` limit");
    expect(providerError(new RangeError("rate limit for org_XyZ9"))).toBe("RangeError: rate limit for org_…");
    expect(providerError("plain org_77")).toBe("plain org_…");
    expect(providerError(404)).toBe("404");
    expect(providerError(new Error("x".repeat(500)))).toHaveLength(300);
  });
});

describe("lib/replan.ts", () => {
  const card = (id: string, o: Partial<Card> = {}): Card => ({ entity_id: id, name: `N-${id}`, entityType: "urn:entity:place", rung: "social", affinity: 0.5, tags: [], why: [], ...o }) as unknown as Card;
  const hist = (o: Partial<PlanHistory> = {}): PlanHistory => ({ rekindled: [], lowRated: [], excludeTags: [], signalTags: [], ...o });
  const G = (s: string) => `urn:tag:genre:place:${s}`;

  it("historyFromRatings: a history without `struck` still works; repeats are deduped; a rated card rescues its own strike", () => {
    const hi = card("hi", { tags: [G("restaurant"), G("restaurant:ramen"), G("restaurant:ramen:tonkotsu"), G("cafe")] });
    const lo = card("lo", { tags: [G("restaurant:ramen"), G("bar:dive")] });
    const prev = hist({ rekindled: [{ entity_id: "hi", name: "N-hi", tags: [], entityType: "urn:entity:place" }] }); // `hi` was already rekindled
    const h = historyFromRatings(prev, [hi, lo], [{ entity_id: "hi", pleasure: 9, mastery: 5 }, { entity_id: "lo", pleasure: 2, mastery: 1 }, { entity_id: "ghost", pleasure: 9, mastery: 1 }], ["hi", "x"]);
    expect(h.rekindled.map((r) => r.entity_id)).toEqual(["hi"]); // deduped, first occurrence kept
    expect(h.lowRated).toEqual(["lo"]);
    expect(h.signalTags).toEqual([G("restaurant:ramen:tonkotsu"), G("restaurant:ramen")]);
    expect(h.excludeTags).toEqual([G("bar:dive")]); // ramen is shared with a liked card, so it is not distinctive
    expect(h.struck).toEqual(["x"]); // `hi` was rated high, so the strike on it is lifted
    expect(historyFromRatings(hist({ struck: ["s"] }), [], [], ["t"]).struck).toEqual(["s", "t"]);
    expect(specificGenreTags([G("restaurant"), "urn:tag:other", G("bar")])).toEqual([G("bar")]);
  });

  it("explainMargin / emberLead: an input missing from the list weighs 0; no rated input means no lead", () => {
    const why = [{ entity_id: "a", score: 0.4 }, { entity_id: "b", score: 0.3 }];
    expect(explainMargin(why, "a")).toBe(0.1);
    expect(explainMargin(why, "missing")).toBe(-0.4);
    expect(explainMargin([], "a")).toBe(0);
    expect(emberLead(why, new Set())).toBeNull();
    expect(emberLead([{ entity_id: "a", score: 0 }], new Set(["a"]))).toBeNull();
    expect(emberLead([{ entity_id: "a", score: 0.5 }], new Set(["a"]))).toMatchObject({ love: null, margin: 0.5, threads: true, co: [] });
  });

  it("diffWeeks: a rated card that left the week is a signal, with the re-check note's detail only when that note is about it and failed", () => {
    const slot = (day: string, c: Card | null) => ({ slot: { day }, card: c });
    const kept = card("kept");
    const sig = card("sig");
    const gone = card("gone");
    const w1 = { slots: [slot("monday", kept), slot("tuesday", sig), slot("wednesday", gone), slot("thursday", null)] } as unknown as WeekPlan;
    const w2 = { slots: [slot("monday", kept), slot("friday", card("new", { why: [{ entity_id: "sig", name: "Sig", score: 0.3 }, { entity_id: "x", name: "Love", score: 0.1 }] as never })), slot("saturday", null)] } as unknown as WeekPlan;
    const h = hist({ rekindled: [{ entity_id: "sig", name: "Sig", tags: [], entityType: "e" }, { entity_id: "kept", name: "Kept", tags: [], entityType: "e" }], lowRated: ["gone"] });
    const plain = diffWeeks(w1, w2, h);
    expect(plain.signals).toEqual([{ day: "tuesday", name: "N-sig", reason: "rated ≥7 — now a Qloo signal for this week" }]);
    expect(plain.kept).toEqual([{ day: "monday", name: "N-kept", reason: "rated ≥7 — kept" }]);
    expect(plain.removed).toEqual([{ day: "wednesday", name: "N-gone", reason: "rated ≤3 — excluded" }]);
    expect(plain.ember).toHaveLength(1);
    const note = (o: Partial<KeptNote>): KeptNote => ({ entity_id: "sig", name: "Sig", ok: false, detail: "closed Mondays", ...o });
    expect(diffWeeks(w1, w2, h, note({})).signals[0]!.reason).toBe("rated ≥7 — not kept: closed Mondays; now a Qloo signal for this week");
    expect(diffWeeks(w1, w2, h, note({ ok: true })).signals[0]!.reason).toBe("rated ≥7 — now a Qloo signal for this week");
    expect(diffWeeks(w1, w2, h, note({ entity_id: "other" })).signals[0]!.reason).toBe("rated ≥7 — now a Qloo signal for this week");
    expect(diffWeeks(w1, w2, h, note({ entity_id: "kept", ok: true, detail: "open Monday" })).kept[0]!.reason).toBe("rated ≥7 — open Monday");
  });

  it("seedRatings skips empty slots and needs ≥ 2 outings and an at-home card; keptCandidate breaks ties by pleasure, outing, then affinity", () => {
    const slot = (c: Card | null) => ({ card: c });
    const home = card("h", { rung: "home", affinity: 0.2 });
    const o1 = card("o1", { affinity: 0.9 });
    const o2 = card("o2", { affinity: 0.1 });
    expect(seedRatings({ slots: [slot(null), slot(home), slot(o1), slot(o2)] } as unknown as WeekPlan)).toEqual([
      { entity_id: "h", pleasure: 7, mastery: 5 },
      { entity_id: "o1", pleasure: 8, mastery: 6 },
      { entity_id: "o2", pleasure: 2, mastery: 3 },
    ]);
    expect(seedRatings({ slots: [slot(home), slot(o1)] } as unknown as WeekPlan)).toBeNull();
    expect(seedRatings({ slots: [slot(o1), slot(o2)] } as unknown as WeekPlan)).toBeNull();

    const cs = [card("home9", { rung: "home", affinity: 0.9 }), card("out7a", { affinity: 0.3 }), card("out7b", { affinity: 0.6 }), card("home7", { rung: "home", affinity: 0.99 }), card("out9", { affinity: 0.1 })];
    const r = (id: string, pleasure: number) => ({ entity_id: id, pleasure, mastery: 0 });
    expect(keptCandidate(cs, [r("home9", 9), r("out9", 9)])?.card.entity_id).toBe("out9"); // same pleasure: the outing wins
    expect(keptCandidate(cs, [r("home9", 9), r("out7a", 8)])?.card.entity_id).toBe("home9"); // higher pleasure wins
    expect(keptCandidate(cs, [r("out7a", 7), r("out7b", 7), r("home7", 7)])?.card.entity_id).toBe("out7b"); // outings first, then higher affinity
    expect(keptCandidate(cs, [r("out7a", 6), r("ghost", 9)])).toBeNull();
    expect(keptCandidate(cs, [r("home7", 7), r("home9", 7)])?.card.entity_id).toBe("home7"); // both at-home: higher affinity
  });
});

describe("lib/resolve.ts", () => {
  const q = (o: { tags?: (t: string, o: unknown) => Promise<unknown>; search?: (t: string, o: unknown) => Promise<unknown> }) => o as unknown as QlooClient;

  it("rankTags: place-restaurant genres first, then any place tag, then the rest; stable within a class", () => {
    expect(rankTags(["urn:tag:a", "urn:tag:x:place:cafe", "urn:tag:genre:place:restaurant:ramen", "urn:tag:b", "urn:tag:genre:place:restaurant:sushi"])).toEqual([
      "urn:tag:genre:place:restaurant:ramen",
      "urn:tag:genre:place:restaurant:sushi",
      "urn:tag:x:place:cafe",
      "urn:tag:a",
      "urn:tag:b",
    ]);
    expect(rankTags([])).toEqual([]);
  });

  it("screenLoveText: refuses clinical vocabulary and contact data, passes tastes", () => {
    const refused = ["PHQ-9 score", "self harm", "20 mg", "my patient", "a@b.co", "718 555 0199", "123-45-6789"];
    for (const t of refused) expect(screenLoveText(t), t).not.toBeNull();
    expect(screenLoveText("sertraline")).toMatch(/health information/);
    expect(screenLoveText("a@b.co")).toMatch(/contact or ID/);
    for (const t of ["ramen", "Blink-182", "The Bear"]) expect(screenLoveText(t), t).toBeNull();
  });

  it("resolveLove: blank or screened text never reaches Qloo", async () => {
    const never = q({ tags: () => Promise.reject(new Error("no request expected")), search: () => Promise.reject(new Error("no request expected")) });
    expect(await resolveLove(never, "   ", "artist")).toEqual([]);
    expect(await resolveLove(never, "suicidal thoughts", "artist")).toEqual([]);
    expect(await resolveLove(never, "mail me a@b.co", "place_tag")).toEqual([]);
  });

  it("resolveLove: tag kinds rank by place preference, take 3, use id or tag_id, drop id-less tags and fall back to the typed text for the name", async () => {
    const seen: [string, unknown][] = [];
    const client = q({
      tags: async (t, o) => {
        seen.push([t, o]);
        return {
          results: {
            tags: [
              { id: "urn:tag:genre:other:one", name: "One" },
              { tag_id: "urn:tag:genre:place:restaurant:ramen" }, // no name → typed text
              { name: "no id" },
              { id: "urn:tag:x:place:cafe", name: "Cafe" },
              { id: "urn:tag:genre:place:restaurant:sushi", name: "Sushi" },
              { id: "urn:tag:genre:place:restaurant:ramen", name: "dup" }, // same id: the later entry wins in the map
            ],
          },
        };
      },
    });
    const out = await resolveLove(client, "  ramen  ", "place_tag");
    expect(seen).toEqual([["ramen", { take: 20 }]]);
    expect(out).toEqual([
      { qloo_id: "urn:tag:genre:place:restaurant:ramen", qloo_kind: "tag", name: "dup" },
      { qloo_id: "urn:tag:genre:place:restaurant:sushi", qloo_kind: "tag", name: "Sushi" },
      { qloo_id: "urn:tag:x:place:cafe", qloo_kind: "tag", name: "Cafe" },
    ]);
    const unnamed = await resolveLove(q({ tags: async () => ({ results: { tags: [{ id: "urn:tag:genre:place:restaurant:ramen" }] } }) }), "ramen", "activity_tag");
    expect(unnamed).toEqual([{ qloo_id: "urn:tag:genre:place:restaurant:ramen", qloo_kind: "tag", name: "ramen" }]);
    expect(await resolveLove(q({ tags: async () => ({}) }), "ramen", "place_tag")).toEqual([]);
    expect(await resolveLove(q({ tags: async () => ({ results: {} }) }), "ramen", "place_tag")).toEqual([]);
  });

  it("resolveLove: entity kinds search pinned to the type and return the top 3; no results is an empty list", async () => {
    for (const kind of LOVE_KINDS.filter((k) => !k.endsWith("_tag"))) {
      const seen: [string, unknown][] = [];
      const out = await resolveLove(
        q({
          search: async (t, o) => {
            seen.push([t, o]);
            return { results: [1, 2, 3, 4].map((n) => ({ entity_id: `id${n}`, name: `Name ${n}` })) };
          },
        }),
        "x".repeat(200),
        kind,
      );
      expect(seen).toEqual([["x".repeat(120), { types: [`urn:entity:${kind}`], take: 3 }]]); // text is cut to 120
      expect(out).toEqual([1, 2, 3].map((n) => ({ qloo_id: `id${n}`, qloo_kind: "entity", entity_type: `urn:entity:${kind}`, name: `Name ${n}` })));
    }
    expect(await resolveLove(q({ search: async () => ({}) }), "Phoebe", "artist")).toEqual([]);
  });
});
