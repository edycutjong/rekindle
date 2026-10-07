/** D9: venue verification (bench arm A oracle), bench arms B / B− / B−4, the bench store prefix, and the outage demo. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { POST as planRoute } from "../app/api/cases/[id]/plan/route";
import { POST as verifyRoute } from "../app/api/verify-venue/route";
import { ownerHash } from "../lib/owner";
import { parseSse } from "../lib/http";
import type { QlooClient, QlooEntity } from "../lib/qloo";
import { storeFor } from "../lib/scope";
import { benchToolOptions, caseFromSeed, runPlanForCase } from "../lib/service";
import { MemoryStore, storeFromEnv, type PlanDoc } from "../lib/store";
import { ALCOHOL_EXCLUDE_4, ALCOHOL_EXCLUDE_14 } from "../lib/tags";
import { gradeEntity, matchHit, namesMatch, normaliseName, verifyVenue, type Geocoder } from "../lib/venue";
import { capturedRaw } from "./fixtures";
import { replayClient } from "./replay";

const search = () => capturedRaw<{ results: QlooEntity[] }>("search-dunwell-near-maya").results;
const DUNWELL = { lat: 40.7074134, lon: -73.9402643 };

describe("venue matching (lib/venue.ts)", () => {
  it("normalises names and matches the same venue, never a fuzzy neighbour", () => {
    expect(normaliseName("Dun-Well Doughnuts")).toBe("dun well doughnuts");
    expect(namesMatch("Dun-Well Doughnuts", "Dun Well Doughnuts")).toBe(true);
    expect(namesMatch("Café Mogador", "Cafe Mogador")).toBe(true);
    expect(namesMatch("Hungry Ghost", "Hungry Ghost Coffee")).toBe(true);
    expect(namesMatch("Dun-Well Doughnuts", "Stitch Well")).toBe(false);
    expect(namesMatch("Dun-Well Doughnuts", "Dunkin'")).toBe(false);
    expect(namesMatch("Ramen Lab", "Ippudo")).toBe(false);
    expect(namesMatch("The Bar", "Bar")).toBe(false);
  });

  it("a hit must match by name AND sit within 300 m of the geocoded point (P23 shape)", () => {
    const hits = search();
    expect(matchHit("Dun-Well Doughnuts", DUNWELL, hits)?.e.name).toBe("Dun-Well Doughnuts");
    // the same name 2 km away from the stated address is not a match
    expect(matchHit("Dun-Well Doughnuts", { lat: DUNWELL.lat + 0.02, lon: DUNWELL.lon }, hits)).toBeNull();
    expect(matchHit("Invented Tea Parlour", DUNWELL, hits)).toBeNull();
  });

  it("grades hours at the slot and alcohol on the Qloo record with the verifier's own functions", () => {
    const dun = search().find((e) => e.name === "Dun-Well Doughnuts")!;
    expect(gradeEntity(dun, "thursday", 15).slot.status).toBe("OPEN");
    expect(gradeEntity(dun, "thursday", 19).slot).toMatchObject({ status: "CLOSED", detail: "closes 18:00" });
    expect(gradeEntity({ ...dun, properties: {} }, "thursday", 15).slot.status).toBe("UNKNOWN");
    expect(gradeEntity({ ...dun, tags: [{ tag_id: "urn:tag:beverage_offering:qloo:craft_beer" }] }, "thursday", 15).alcohol.verdict).toBe("REFUSE");
    expect(gradeEntity({ ...dun, properties: { ...dun.properties, is_closed: true } }, "thursday", 15).slot.status).toBe("CLOSED");
  });

  it("verifyVenue: geocode → /search → match → grade; an address that does not geocode is unverifiable", async () => {
    const calls: unknown[] = [];
    const qloo = {
      search: async (q: string, o: unknown) => {
        calls.push({ q, o });
        return { results: search() };
      },
    } as unknown as QlooClient;
    const geo: Geocoder = async (a) => (a.includes("Montrose") ? { ...DUNWELL, display_name: "222 Montrose Ave" } : null);
    const ok = await verifyVenue(qloo, geo, { name: "Dun-Well Doughnuts", address: "222 Montrose Ave, Brooklyn", day: "thursday", hour: 15, origin: { lat: 40.7081, lon: -73.9571 } });
    expect(ok).toMatchObject({ verifiable: true, mode: "address", slot: { status: "OPEN" }, alcohol: { verdict: "PASS" } });
    expect(ok.distance_from_origin_m).toBeGreaterThan(1300);
    expect(calls[0]).toMatchObject({ q: "Dun-Well Doughnuts", o: { types: ["urn:entity:place"], extra: { "filter.location": `${DUNWELL.lat},${DUNWELL.lon}`, "filter.radius": 1 } } });
    const bad = await verifyVenue(qloo, geo, { name: "Dun-Well Doughnuts", address: "1 Nowhere Lane", day: "thursday", hour: 15 });
    expect(bad).toMatchObject({ verifiable: false, geocode: null, candidates: 0 });
    expect(calls).toHaveLength(1); // no Qloo call without a geocode
  });

  it("verifyVenue by entity_id grades the Qloo record directly (arm B, Qloo-graded)", async () => {
    const dun = search().find((e) => e.name === "Dun-Well Doughnuts")!;
    const qloo = { entities: async (ids: string[]) => ({ results: ids[0] === dun.entity_id ? [dun] : [] }) } as unknown as QlooClient;
    const never: Geocoder = async () => {
      throw new Error("no geocode in entity mode");
    };
    expect(await verifyVenue(qloo, never, { name: "x", entity_id: dun.entity_id, day: "thursday", hour: 18 })).toMatchObject({ mode: "entity", verifiable: true, slot: { status: "CLOSED" } });
    expect(await verifyVenue(qloo, never, { name: "x", entity_id: "NOPE", day: "thursday", hour: 18 })).toMatchObject({ verifiable: false });
  });
});

describe("bench arms (lib/service.ts)", () => {
  it("B keeps R-ALC's screen and the 14 tags; B− turns the screen off; B−4 also sends only the 4 bar tags", () => {
    expect(benchToolOptions("B")).toEqual({ alcoholScreen: true, excludeTagSet: ALCOHOL_EXCLUDE_14 });
    expect(benchToolOptions("B-")).toEqual({ alcoholScreen: false, excludeTagSet: ALCOHOL_EXCLUDE_14 });
    expect(benchToolOptions("B-4")).toEqual({ alcoholScreen: false, excludeTagSet: ALCOHOL_EXCLUDE_4 });
  });

  it("a bench run records the arm and audits the verifier's full input pool for alcohol, before any other rule", async () => {
    const store = new MemoryStore("bench/");
    const c = { ...caseFromSeed("maya")!, in_recovery: true };
    await store.putCase(c);
    const seen: Record<string, unknown>[] = [];
    const plan = await runPlanForCase({ store, caseId: c.id, qloo: () => replayClient(seen as never), llms: [], bench: "B-4" });
    expect(plan.bench).toMatchObject({ arm: "B-4", alcohol_screen: false, exclude_set: "4" });
    expect(plan.bench!.pools).toBeGreaterThan(0);
    expect(plan.bench!.pool_entities).toBeGreaterThan(0);
    // the replay pool with exclusions is the captured 14-tag list, which still carries the P19 leaks
    const names = plan.bench!.pool_alcohol.map((x) => x.name);
    expect(names).toEqual(expect.arrayContaining(["Hungry Ghost Coffee"]));
    expect(plan.bench!.pool_alcohol.find((x) => x.name === "Hungry Ghost Coffee")!.hits.join(" ")).toMatch(/specialty_alcoholic/);
    const placeReq = seen.find((p) => p["filter.type"] === "urn:entity:place")!;
    expect(placeReq["filter.exclude.tags"]).toEqual([...ALCOHOL_EXCLUDE_4]);
    // the screen is off: the R-ALC check says so on every outing card
    for (const card of plan.cards.filter((x) => x.rung !== "home")) expect(card.checks.find((x) => x.rule === "R-ALC")!.detail).toBe("screen off (ablation)");
  });

  it("arm B (screen on) never places an alcohol-flagged venue for a patient in recovery", async () => {
    const store = new MemoryStore("bench/");
    const c = { ...caseFromSeed("maya")!, in_recovery: true };
    await store.putCase(c);
    const plan = await runPlanForCase({ store, caseId: c.id, qloo: () => replayClient(), llms: [], bench: "B" });
    const flagged = new Set(plan.bench!.pool_alcohol.filter((x) => x.verdict === "REFUSE").map((x) => x.entity_id));
    expect(flagged.size).toBeGreaterThan(0);
    expect(plan.cards.filter((x) => flagged.has(x.qloo_entity_id))).toHaveLength(0);
  });

  it("the injected Qloo outage leaves every slot empty with the reason and never fills one from the model", async () => {
    const store = new MemoryStore();
    const c = caseFromSeed("maya")!;
    await store.putCase(c);
    const plan = await runPlanForCase({ store, caseId: c.id, fault: "qloo_unreachable" });
    expect(plan.fault).toBe("qloo_unreachable");
    expect(plan.cards).toHaveLength(0);
    expect(plan.empty_slots).toHaveLength(7);
    for (const e of plan.empty_slots) expect(e.reason).toMatch(/^Qloo unavailable/);
    expect(plan.llm_model).toBeNull();
    const calls = (await store.getCalls(plan.id))!.calls;
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((x) => x.status === 0)).toBe(true);
  });
});

describe("bench scope + routes", () => {
  afterEach(() => vi.unstubAllEnvs());
  const BENCH = "b".repeat(32);

  it("bench-token requests use the bench/ prefix; others the product prefix (same backing store)", async () => {
    vi.stubEnv("BENCH_TOKEN", BENCH);
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
    const bench = storeFor({ headers: new Headers({ "x-bench-token": BENCH }) });
    const pub = storeFor({ headers: new Headers() });
    const c = caseFromSeed("maya")!;
    await bench.putCase(c);
    expect(await bench.getCase(c.id)).toEqual(c);
    expect(await pub.getCase(c.id)).toBeNull();
    expect(storeFromEnv({}, "bench/")).toBeInstanceOf(MemoryStore);
  });

  it("verify-venue is bench only; plan bench arms need the bench token; bad bodies are 400", async () => {
    vi.stubEnv("BENCH_TOKEN", BENCH);
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
    const body = JSON.stringify({ name: "Dun-Well Doughnuts", address: "222 Montrose Ave", day: "thursday", hour: 15 });
    expect((await verifyRoute(new Request("http://x/api/verify-venue", { method: "POST", body }))).status).toBe(403);
    const bad = await verifyRoute(new Request("http://x/api/verify-venue", { method: "POST", body: JSON.stringify({ name: "x", day: "thursday", hour: 15 }), headers: { "x-bench-token": BENCH } }));
    expect(bad.status).toBe(400);
    const id = crypto.randomUUID();
    const ctx = { params: Promise.resolve({ id }) };
    expect((await planRoute(new Request(`http://x/api/cases/${id}/plan`, { method: "POST", body: JSON.stringify({ bench: "B-" }) }), ctx)).status).toBe(403);
    expect((await planRoute(new Request(`http://x/api/cases/${id}/plan`, { method: "POST", body: JSON.stringify({ bench: "Z" }) }), ctx)).status).toBe(400);
    expect((await planRoute(new Request(`http://x/api/cases/${id}/plan`, { method: "POST", body: JSON.stringify({ bench: "B", fault: "qloo_unreachable" }) }), ctx)).status).toBe(400);
  });

  it("the outage demo streams over the plan route for an anonymous visitor", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
    const store = storeFromEnv();
    const c = { ...caseFromSeed("maya")!, owner_hash: ownerHash("outage-visitor-token-0123456789ab") };
    await store.putCase(c);
    const res = await planRoute(new Request(`http://x/api/cases/${c.id}/plan`, { method: "POST", body: JSON.stringify({ fault: "qloo_unreachable" }), headers: { cookie: "rk_owner=outage-visitor-token-0123456789ab", "x-forwarded-for": "10.9.9.9" } }), { params: Promise.resolve({ id: c.id }) });
    const frames = parseSse(await res.text());
    const plan = (frames.at(-1)!.data as { plan: PlanDoc }).plan;
    expect(plan.fault).toBe("qloo_unreachable");
    expect(plan.empty_slots.every((e) => e.reason.startsWith("Qloo unavailable"))).toBe(true);
  });
});
