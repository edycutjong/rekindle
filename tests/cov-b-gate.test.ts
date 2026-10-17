import { afterEach, describe, expect, it, vi } from "vitest";
import { approveWeek, claimReplan, ratingsOf, rateWeek, replanPrecheck, replanWeek } from "../lib/gate";
import { Conflict, RUN_STALE_MS } from "../lib/service";
import { CardDoc, CaseDoc, MemoryStore, PlanDoc, type RunDocIn } from "../lib/store";

const CASE_ID = "11111111-1111-4111-8111-111111111111";
const PARENT = "22222222-2222-4222-8222-222222222222";
const CHILD = "33333333-3333-4333-8333-333333333333";
const MISSING = "99999999-9999-4999-8999-999999999999";
const NOW = Date.parse("2026-10-10T12:00:00Z");

const caseDoc = () =>
  CaseDoc.parse({
    id: CASE_ID,
    label: "Test",
    created_at: "2026-10-01T00:00:00Z",
    point_wkt: "POINT(-73.9571 40.7081)",
    lon: -73.9571,
    lat: 40.7081,
    energy: 1,
    price_max: 2,
    max_meters: 1500,
    in_recovery: false,
    need_quiet: false,
    need_wheelchair: false,
    loves: [{ id: "l1", text: "ramen", qloo_id: "urn:tag:genre:place:restaurant:ramen", qloo_kind: "tag" }],
  });

const days = ["monday", "tuesday", "wednesday", "thursday"] as const;
const cardDoc = (i: number, o: Partial<CardDoc> = {}): CardDoc =>
  CardDoc.parse({
    id: `card-${i}`,
    plan_id: PARENT,
    day: i,
    day_name: days[i],
    hour: 19,
    slot_hour: 19,
    rung: "home",
    home_type: "artist",
    qloo_entity_id: `E-${i}`,
    name: `Thing ${i}`,
    entity_type: "urn:entity:artist",
    affinity: 0.5,
    explain_json: [],
    tags: [],
    checks: [],
    verdict: "PASS",
    ...o,
  });

const planDoc = (o: Record<string, unknown> = {}): PlanDoc =>
  PlanDoc.parse({
    id: PARENT,
    case_id: CASE_ID,
    week: 1,
    status: "draft",
    created_at: "2026-10-01T00:00:00Z",
    llm_provider: null,
    llm_model: null,
    qloo_calls: 0,
    latency_ms: 0,
    history: { rekindled: [], lowRated: [], excludeTags: [], signalTags: [] },
    cards: [0, 1, 2, 3].map((i) => cardDoc(i)),
    empty_slots: [],
    refusals: [],
    review: [],
    dropped: [],
    ...o,
  });

const run = (o: Partial<RunDocIn> = {}): RunDocIn => ({ case_id: CASE_ID, parent_plan_id: PARENT, status: "running", plan_id: null, started_at: new Date(NOW).toISOString(), updated_at: new Date(NOW).toISOString(), ...o });

async function seeded(plan: PlanDoc = planDoc()) {
  const store = new MemoryStore();
  await store.putCase(caseDoc());
  await store.putPlan(plan);
  return store;
}

const approvedCards = (pleasure: (number | null)[]) => [0, 1, 2, 3].map((i) => cardDoc(i, { clinician_action: "approved", pleasure: pleasure[i] ?? null, mastery: pleasure[i] == null ? null : 4 }));

afterEach(() => vi.unstubAllEnvs());

describe("rateWeek", () => {
  it("an unknown plan is NotFound and a card the clinician never approved cannot be rated", async () => {
    const store = await seeded(planDoc({ status: "approved", cards: [cardDoc(0, { clinician_action: "approved" }), cardDoc(1)] }));
    await expect(rateWeek({ store, planId: MISSING, ratings: [] })).rejects.toThrow(/plan .* not found/);
    await expect(rateWeek({ store, planId: PARENT, ratings: [{ card_id: "card-1", pleasure: 5 }] })).rejects.toThrow(/Thing 1 was not approved/);
  });

  it("mastery is optional (stored as null), and an empty request leaves the week approved", async () => {
    const store = await seeded(planDoc({ status: "approved", cards: approvedCards([]) }));
    const none = await rateWeek({ store, planId: PARENT, ratings: [] });
    expect(none.status).toBe("approved");
    const one = await rateWeek({ store, planId: PARENT, ratings: [{ card_id: "card-0", pleasure: 6 }] });
    expect(one.status).toBe("rated");
    expect(one.cards[0]).toMatchObject({ pleasure: 6, mastery: null });
  });

  it("ratingsOf reports a missing mastery as 0 and skips unrated cards", () => {
    const plan = planDoc({ cards: [cardDoc(0, { pleasure: 7, mastery: null }), cardDoc(1, { pleasure: 2, mastery: 5 }), cardDoc(2)] });
    expect(ratingsOf(plan)).toEqual([{ entity_id: "E-0", pleasure: 7, mastery: 0 }, { entity_id: "E-1", pleasure: 2, mastery: 5 }]);
  });
});

describe("replanPrecheck", () => {
  it("unknown plan", async () => {
    await expect(replanPrecheck(await seeded(), MISSING, NOW)).rejects.toThrow(/plan .* not found/);
  });

  it("a week that names a next plan returns that plan; a dangling pointer falls through to the run marker and the rating checks", async () => {
    const store = await seeded(planDoc({ status: "rated", next_plan_id: CHILD, cards: approvedCards([8, 4, 2, null]) }));
    await store.putPlan(planDoc({ id: CHILD, week: 2, parent_plan_id: PARENT }));
    expect((await replanPrecheck(store, PARENT, NOW)).existing?.id).toBe(CHILD);

    const dangling = await seeded(planDoc({ status: "rated", next_plan_id: CHILD, cards: approvedCards([8, 4, 2, null]) }));
    expect((await replanPrecheck(dangling, PARENT, NOW)).existing).toBeNull();
  });

  it("a finished run marker returns its week; a marker whose week is gone is ignored", async () => {
    const rated = planDoc({ status: "rated", cards: approvedCards([8, 4, 2, null]) });
    const store = await seeded(rated);
    await store.putPlan(planDoc({ id: CHILD, week: 2 }));
    await store.putRun(run({ status: "done", plan_id: CHILD }));
    expect((await replanPrecheck(store, PARENT, NOW)).existing?.id).toBe(CHILD);

    const gone = await seeded(rated);
    await gone.putRun(run({ status: "done", plan_id: CHILD }));
    expect((await replanPrecheck(gone, PARENT, NOW)).existing).toBeNull();
  });

  it("a run marker that cannot be read is treated as no marker", async () => {
    const store = await seeded(planDoc({ status: "rated", cards: approvedCards([8, 4, 2, null]) }));
    store.getReplanRun = async () => {
      throw new Error("blob down");
    };
    expect((await replanPrecheck(store, PARENT, NOW)).existing).toBeNull();
  });

  it("a fresh running marker blocks (unless the caller holds the claim); a stale one does not", async () => {
    const store = await seeded(planDoc({ status: "rated", cards: approvedCards([8, 4, 2, null]) }));
    await store.putRun(run());
    await expect(replanPrecheck(store, PARENT, NOW + 1000)).rejects.toMatchObject({ name: "Conflict", body: { running: true } });
    expect((await replanPrecheck(store, PARENT, NOW + 1000, { ownClaim: true })).existing).toBeNull();
    expect((await replanPrecheck(store, PARENT, NOW + RUN_STALE_MS + 1)).existing).toBeNull();
  });

  it("explains which step comes first and how many ratings are missing", async () => {
    const msg = async (o: Record<string, unknown>) => replanPrecheck(await seeded(planDoc(o)), PARENT, NOW).catch((e: Error) => e.message);
    expect(await msg({ status: "draft" })).toBe("approve the week before re-planning it");
    expect(await msg({ status: "approved", cards: approvedCards([]) })).toBe("rate the week before re-planning it");
    expect(await msg({ status: "rated", cards: approvedCards([8, 4]) })).toBe("rate at least 3 activities before re-planning (2 rated)");
  });
});

describe("claimReplan", () => {
  const parent = planDoc({ status: "rated" });

  it("claims when there is no marker or the marker failed", async () => {
    const store = await seeded();
    expect(await claimReplan(store, parent, NOW)).toEqual({ claimed: { started_at: new Date(NOW).toISOString() } });
    await store.putRun(run({ status: "failed" }));
    expect(await claimReplan(store, parent, NOW)).toEqual({ claimed: { started_at: new Date(NOW).toISOString() } });
  });

  it("returns the week another request already made, but a done marker whose week is gone, or a live one, is a running conflict", async () => {
    const store = await seeded();
    await store.putPlan(planDoc({ id: CHILD, week: 2 }));
    await store.putRun(run({ status: "done", plan_id: CHILD }));
    expect(await claimReplan(store, parent, NOW)).toMatchObject({ plan: { id: CHILD } });

    for (const marker of [run({ status: "done", plan_id: MISSING }), run({ status: "done", plan_id: null }), run({ status: "running" })]) {
      const s = await seeded();
      await s.putRun(marker);
      await expect(claimReplan(s, parent, NOW + 1000)).rejects.toBeInstanceOf(Conflict);
    }
  });
});

describe("replanWeek", () => {
  const ratedPlan = (pleasure: (number | null)[]) => planDoc({ status: "rated", cards: approvedCards(pleasure) });

  it("another request finishing between the precheck and the claim returns its week", async () => {
    const store = await seeded(ratedPlan([8, 4, 2, null]));
    await store.putPlan(planDoc({ id: CHILD, week: 2 }));
    await store.putRun(run({ status: "done", plan_id: CHILD }));
    // the precheck sees no marker; by the time this request claims, the other run has finished
    const reads = store.getReplanRun.bind(store);
    let first = true;
    store.getReplanRun = async (id) => (first ? ((first = false), null) : reads(id));
    const r = await replanWeek({ store, planId: PARENT });
    expect(r).toMatchObject({ reused: true, plan: { id: CHILD } });
  });

  it("a failed run is marked failed even when the marker write itself fails, and the original error is the one thrown", async () => {
    const store = new MemoryStore();
    await store.putPlan(ratedPlan([8, 4, 2, null])); // no case stored: the run fails after the claim
    const puts: string[] = [];
    const put = store.putRun.bind(store);
    store.putRun = async (d) => {
      puts.push(d.status);
      if (d.status === "failed") throw new Error("marker write failed");
      return put(d);
    };
    await expect(replanWeek({ store, planId: PARENT })).rejects.toThrow(/case .* not found/);
    expect(puts).toEqual(["failed"]);
    // and with a working store the marker says failed, so the next click can retry
    const ok = new MemoryStore();
    await ok.putPlan(ratedPlan([8, 4, 2, null]));
    await expect(replanWeek({ store: ok, planId: PARENT })).rejects.toThrow(/case .* not found/);
    expect((await ok.getReplanRun(PARENT))!.status).toBe("failed");
  });

  it("with no injected Qloo client or LLM chain, both come from the environment; low ratings keep nothing", async () => {
    vi.stubEnv("QLOO_API_KEY", "test-key");
    vi.stubEnv("QWEN_API_KEY", "");
    vi.stubEnv("GROQ_API_KEY", "");
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (u: string) => {
      urls.push(new URL(u).pathname);
      return Response.json({ results: { entities: [] } });
    });
    const store = await seeded(ratedPlan([5, 4, 2, null]));
    const events: string[] = [];
    const { plan, reused } = await replanWeek({ store, planId: PARENT, claimed: { started_at: new Date().toISOString() }, onEvent: (e) => void events.push(e.type) });
    vi.unstubAllGlobals();
    expect(reused).toBe(false);
    expect(plan).toMatchObject({ week: 2, origin: "replan", parent_plan_id: PARENT });
    // nobody rated 7 or more: no live re-check of a kept activity
    expect(urls).not.toContain("/entities");
    expect(urls.length).toBeGreaterThan(0);
    expect(plan.diff!.kept_check).toBeNull();
    expect(events).toContain("qloo");
    expect((await store.getReplanRun(PARENT))!.status).toBe("done");
    expect((await store.getPlan(PARENT))!.next_plan_id).toBe(plan.id);
  });
});

describe("approveWeek", () => {
  it("is unaffected by pre-existing ratings: every card is stamped", async () => {
    const store = await seeded();
    const a = await approveWeek({ store, planId: PARENT });
    expect(a.cards.every((c) => c.clinician_action === "approved")).toBe(true);
  });
});
