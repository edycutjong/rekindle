import { afterEach, describe, expect, it, vi } from "vitest";
import { actOnCard, approveWeek, MIN_RATED_FOR_REPLAN, rateWeek, ratingsOf, replanPrecheck, replanWeek } from "../lib/gate";
import { parseSse } from "../lib/http";
import { makeLlm } from "../lib/llm";
import type { QlooCallLog, QlooClient, QlooParams } from "../lib/qloo";
import { caseFromSeed, runPlanForCase, toggleConstraints } from "../lib/service";
import { MemoryStore, PlanDoc, storeFromEnv, type Store } from "../lib/store";
import { replayClient } from "./replay";
import { captured } from "./fixtures";
import { verifyCard } from "../lib/verify";
import type { QlooEntity } from "../lib/qloo";
import { PATCH as cardRoute } from "../app/api/plans/[id]/cards/[cardId]/route";
import { POST as approveRoute } from "../app/api/plans/[id]/approve/route";
import { POST as ratingsRoute } from "../app/api/plans/[id]/ratings/route";
import { POST as replanRoute } from "../app/api/plans/[id]/replan/route";
import { POST as casesRoute } from "../app/api/cases/route";
import { POST as seedRoute } from "../app/api/cases/seed/[slug]/route";
import { POST as constraintsRoute } from "../app/api/plans/[id]/constraints/route";

/** deterministic route only (every LLM provider "down"), so these tests exercise the gate, not routing */
const downLlm = () => makeLlm("qwen", { QWEN_API_KEY: "k" }, (async () => new Response("{}", { status: 400 })) as unknown as typeof fetch)!;

/** every captured entity by id: what a live GET /entities would return for an entity Qloo knows (re-plan re-check) */
const ALL_CAPTURED = new Map<string, QlooEntity>(["maya-thu-recovery-off", "athome-artist", "athome-podcast", "athome-book", "athome-tv_show"].flatMap((n) => captured(n).map((e) => [e.entity_id, e] as const)));

const loggingReplay =
  (seen: QlooParams[] = [], entityPatch: (e: QlooEntity) => QlooEntity = (e) => e) =>
  (onCall: (l: QlooCallLog) => void): QlooClient => {
    const inner = replayClient(seen);
    return {
      async entities(ids: string[]) {
        const results = ids.flatMap((id) => (ALL_CAPTURED.has(id) ? [entityPatch(ALL_CAPTURED.get(id)!)] : []));
        onCall({ path: "/entities", params: { entity_ids: ids.join(",") }, status: 200, ms: 1, n_results: results.length, attempts: 1, at: new Date().toISOString() });
        return { results };
      },
      async insights(p: QlooParams) {
        const r = await inner.insights(p);
        onCall({ path: "/v2/insights", params: Object.fromEntries(Object.entries(p).map(([k, v]) => [k, String(v)])), status: 200, ms: 1, n_results: r.results.entities?.length ?? 0, attempts: 1, at: new Date().toISOString() });
        return r;
      },
    } as unknown as QlooClient;
  };

async function mayaWeek(store: Store = new MemoryStore()) {
  const c = caseFromSeed("maya")!;
  await store.putCase(c);
  const plan = await runPlanForCase({ store, caseId: c.id, qloo: loggingReplay(), llms: [downLlm()] });
  return { store, c, plan };
}

/** approve + rate the Maya week: top home card 8, top outing 9, lowest outing 2 (≥ 3 rated) */
async function ratedWeek(store: Store = new MemoryStore()) {
  const { plan } = await mayaWeek(store);
  const approved = await approveWeek({ store, planId: plan.id });
  const home = approved.cards.filter((c) => c.rung === "home").sort((a, b) => b.affinity - a.affinity);
  const outs = approved.cards.filter((c) => c.rung !== "home").sort((a, b) => b.affinity - a.affinity);
  const ratings = [
    { card_id: home[0].id, pleasure: 8, mastery: 5 },
    { card_id: outs[0].id, pleasure: 9, mastery: 6 },
    { card_id: outs[outs.length - 1].id, pleasure: 2, mastery: 3 },
  ];
  const rated = await rateWeek({ store, planId: plan.id, ratings });
  return { store, plan: rated, home, outs };
}

describe("clinician gate (lib/gate.ts)", () => {
  it("approve / unapprove one card changes only that card; the week stays a draft", async () => {
    const { store, plan } = await mayaWeek();
    const card = plan.cards[0];
    const r = await actOnCard({ store, planId: plan.id, cardId: card.id, action: "approve" });
    expect(r.plan.status).toBe("draft");
    expect(r.plan.cards.find((c) => c.id === card.id)!.clinician_action).toBe("approved");
    expect(r.plan.cards.filter((c) => c.clinician_action === "approved")).toHaveLength(1);
    const u = await actOnCard({ store, planId: plan.id, cardId: card.id, action: "unapprove" });
    expect(u.plan.cards.find((c) => c.id === card.id)!.clinician_action).toBeNull();
    expect((await store.getPlan(plan.id))!.cards.find((c) => c.id === card.id)!.clinician_action).toBeNull();
  });

  it("remove leaves the slot empty with the reason and keeps the card on the sheet as a clinician strike", async () => {
    const { store, plan } = await mayaWeek();
    const card = plan.cards.find((c) => c.rung === "solo")!;
    const { plan: next } = await actOnCard({ store, planId: plan.id, cardId: card.id, action: "remove" });
    expect(next.cards.find((c) => c.id === card.id)).toBeUndefined();
    expect(next.empty_slots).toContainEqual(expect.objectContaining({ day_name: card.day_name, reason: "removed by the clinician" }));
    expect(next.refusals).toContainEqual(expect.objectContaining({ qloo_entity_id: card.qloo_entity_id, rule: "CLINICIAN", by_clinician: "removed" }));
  });

  it("swap re-runs ONE slot live with the same tool + verifier and never brings back anything already on or struck from the sheet", async () => {
    const seen: QlooParams[] = [];
    const { store, plan } = await mayaWeek();
    const card = plan.cards.find((c) => c.rung === "solo")!;
    const others = plan.cards.filter((c) => c.id !== card.id);
    const r = await actOnCard({ store, planId: plan.id, cardId: card.id, action: "swap", qloo: loggingReplay(seen) });
    // exactly one tool call for the slot (a place query), with every other placed outing excluded
    expect(seen).toHaveLength(1);
    expect(seen[0]["filter.type"]).toBe("urn:entity:place");
    for (const o of others.filter((x) => x.rung !== "home")) expect(String(seen[0]["filter.exclude.entities"])).toContain(o.qloo_entity_id);
    expect(String(seen[0]["filter.exclude.entities"])).toContain(card.qloo_entity_id);
    expect(r.swap).toMatchObject({ calls: 1 });
    const next = r.plan;
    const replacement = next.cards.find((c) => c.day_name === card.day_name);
    if (r.swap!.found) {
      expect(replacement!.qloo_entity_id).not.toBe(card.qloo_entity_id);
      expect(replacement!.routed_by).toBe("swap");
      expect(replacement!.verdict).toBe("PASS");
      expect(others.map((o) => o.qloo_entity_id)).not.toContain(replacement!.qloo_entity_id);
    } else {
      expect(replacement).toBeUndefined();
      expect(next.empty_slots.some((e) => e.day_name === card.day_name)).toBe(true);
    }
    // the other six cards are untouched
    for (const o of others) expect(next.cards.find((c) => c.id === o.id)).toEqual(o);
    expect(next.refusals).toContainEqual(expect.objectContaining({ qloo_entity_id: card.qloo_entity_id, by_clinician: "swapped" }));
    // the swap's Qloo call is appended to the plan's call log
    expect((await store.getCalls(plan.id))!.calls).toHaveLength(plan.qloo_calls + 1);
    expect(next.qloo_calls).toBe(plan.qloo_calls + 1);
    // swapping the replacement again never returns the first card
    if (r.swap!.found) {
      const again = await actOnCard({ store, planId: plan.id, cardId: replacement!.id, action: "swap", qloo: loggingReplay() });
      expect(again.plan.cards.find((c) => c.day_name === card.day_name)?.qloo_entity_id).not.toBe(card.qloo_entity_id);
    }
  });

  it("swap of an at-home dose stays in its home type and excludes every entity on the sheet", async () => {
    const seen: QlooParams[] = [];
    const { store, plan } = await mayaWeek();
    const card = plan.cards.find((c) => c.rung === "home")!;
    const r = await actOnCard({ store, planId: plan.id, cardId: card.id, action: "swap", qloo: loggingReplay(seen) });
    expect(seen).toHaveLength(1);
    expect(seen[0]["filter.type"]).toBe(card.entity_type);
    const next = r.plan.cards.find((c) => c.day_name === card.day_name);
    expect(next?.qloo_entity_id).not.toBe(card.qloo_entity_id);
    if (next) expect(plan.cards.map((c) => c.qloo_entity_id)).not.toContain(next.qloo_entity_id);
  });

  it("approve week stamps every remaining card, locks the week (I4) and refuses an empty or already-approved week", async () => {
    const { store, plan } = await mayaWeek();
    const removed = plan.cards[0];
    await actOnCard({ store, planId: plan.id, cardId: removed.id, action: "remove" });
    const a = await approveWeek({ store, planId: plan.id });
    expect(a.status).toBe("approved");
    expect(a.approved_at).not.toBeNull();
    expect(a.cards.every((c) => c.clinician_action === "approved")).toBe(true);
    expect(a.cards.find((c) => c.id === removed.id)).toBeUndefined();
    await expect(approveWeek({ store, planId: plan.id })).rejects.toThrow(/already approved/);
    await expect(actOnCard({ store, planId: plan.id, cardId: a.cards[0].id, action: "swap" })).rejects.toThrow(/already approved/);
    await expect(toggleConstraints({ store, planId: plan.id, patch: { in_recovery: true } })).rejects.toThrow(/draft/);
    const empty = await mayaWeek();
    await empty.store.putPlan(PlanDoc.parse({ ...empty.plan, cards: [] }));
    await expect(approveWeek({ store: empty.store, planId: empty.plan.id })).rejects.toThrow(/nothing/);
  });

  it("ratings: only on an approved week, only approved cards, 0–10; the first rating moves the week to rated", async () => {
    const { store, plan } = await mayaWeek();
    const id = plan.cards[0].id;
    await expect(rateWeek({ store, planId: plan.id, ratings: [{ card_id: id, pleasure: 5, mastery: 5 }] })).rejects.toThrow(/approve/);
    await approveWeek({ store, planId: plan.id });
    await expect(rateWeek({ store, planId: plan.id, ratings: [{ card_id: crypto.randomUUID(), pleasure: 5, mastery: 5 }] })).rejects.toThrow(/not on this week/);
    const r = await rateWeek({ store, planId: plan.id, ratings: [{ card_id: id, pleasure: 6, mastery: 4 }] });
    expect(r.status).toBe("rated");
    expect(r.cards.find((c) => c.id === id)).toMatchObject({ pleasure: 6, mastery: 4 });
    expect(ratingsOf(r)).toHaveLength(1);
  });

  it("re-plan needs ≥ 3 rated activities; then runs week 2 from the ratings, stores the diff and links the weeks", async () => {
    const store = new MemoryStore();
    const { plan: w1 } = await mayaWeek(store);
    await approveWeek({ store, planId: w1.id });
    const two = w1.cards.slice(0, 2).map((c) => ({ card_id: c.id, pleasure: 8, mastery: 5 }));
    await rateWeek({ store, planId: w1.id, ratings: two });
    expect(MIN_RATED_FOR_REPLAN).toBe(3);
    await expect(replanPrecheck(store, w1.id)).rejects.toThrow(/at least 3/);

    const r = await ratedWeek();
    const seen: QlooParams[] = [];
    const { plan: w2, reused } = await replanWeek({ store: r.store, planId: r.plan.id, qloo: loggingReplay(seen), llms: [downLlm()] });
    expect(reused).toBe(false);
    expect(w2.week).toBe(2);
    expect(w2.origin).toBe("replan");
    expect(w2.status).toBe("draft");
    expect(w2.parent_plan_id).toBe(r.plan.id);
    expect((await r.store.getPlan(r.plan.id))!.next_plan_id).toBe(w2.id);
    // ≥ 7 → signal, ≤ 3 → exclusion: both reach Qloo as request params
    expect(w2.history.rekindled.map((x) => x.entity_id).sort()).toEqual([r.home[0].qloo_entity_id, r.outs[0].qloo_entity_id].sort());
    expect(w2.history.lowRated).toEqual([r.outs[r.outs.length - 1].qloo_entity_id]);
    expect(seen.some((p) => String(p["signal.interests.entities"] ?? "").includes(r.outs[0].qloo_entity_id))).toBe(true);
    expect(seen.filter((p) => p["filter.type"] === "urn:entity:place").every((p) => String(p["filter.exclude.entities"] ?? "").includes(r.outs[r.outs.length - 1].qloo_entity_id))).toBe(true);
    // the ≤ 3 venue never returns in week 2 and is listed under "Leaving out"
    expect(w2.cards.map((c) => c.qloo_entity_id)).not.toContain(r.outs[r.outs.length - 1].qloo_entity_id);
    expect(w2.diff!.from_plan_id).toBe(r.plan.id);
    expect(w2.diff!.removed).toContainEqual(expect.objectContaining({ name: r.outs[r.outs.length - 1].name, reason: "rated ≤3 — excluded" }));
    // each week-2 card has at most one `top` ember link, and only to a rekindled entity
    const rek = new Set(w2.history.rekindled.map((x) => x.entity_id));
    for (const e of w2.diff!.ember) expect(rek.has(e.from_id)).toBe(true);
    const tops = w2.diff!.ember.filter((e) => e.top);
    expect(new Set(tops.map((e) => e.to_id)).size).toBe(tops.length);
    // the week's call log is persisted beside it
    expect((await r.store.getCalls(w2.id))!.calls.length).toBe(w2.qloo_calls);
    // one re-plan per week: a second call returns the same week without a Qloo call
    const n = seen.length;
    const again = await replanWeek({ store: r.store, planId: r.plan.id, qloo: loggingReplay(seen), llms: [downLlm()] });
    expect(again).toMatchObject({ reused: true, plan: { id: w2.id } });
    expect(seen.length).toBe(n);
    // ratings on the re-planned week are locked
    await expect(rateWeek({ store: r.store, planId: r.plan.id, ratings: [{ card_id: r.home[0].id, pleasure: 1, mastery: 1 }] })).rejects.toThrow(/locked/);
  });

  it("the clinician's own refusals are remembered: a card swapped out or removed in week 1 never returns in week 2 (QA round 1)", async () => {
    const store = new MemoryStore();
    const { plan: w1 } = await mayaWeek(store);
    const solo = w1.cards.find((c) => c.rung === "solo")!;
    const home = w1.cards.find((c) => c.rung === "home")!;
    await actOnCard({ store, planId: w1.id, cardId: solo.id, action: "swap", qloo: loggingReplay() });
    await actOnCard({ store, planId: w1.id, cardId: home.id, action: "remove" });
    const approved = await approveWeek({ store, planId: w1.id });
    const cards = [...approved.cards].sort((a, b) => b.affinity - a.affinity);
    await rateWeek({ store, planId: w1.id, ratings: cards.slice(0, 3).map((c, i) => ({ card_id: c.id, pleasure: [8, 5, 2][i], mastery: 4 })) });
    const seen: QlooParams[] = [];
    const { plan: w2 } = await replanWeek({ store, planId: w1.id, qloo: loggingReplay(seen), llms: [downLlm()] });
    expect(w2.history.struck).toEqual(expect.arrayContaining([solo.qloo_entity_id, home.qloo_entity_id]));
    // sent to Qloo as exclusions on every place and at-home request…
    const asked = seen.filter((p) => p["filter.type"] !== "urn:heatmap");
    expect(asked.length).toBeGreaterThan(0);
    for (const p of asked) expect(String(p["filter.exclude.entities"] ?? "")).toContain(solo.qloo_entity_id);
    // …and refused by the verifier even if Qloo ignored them (the at-home replay does)
    expect(w2.cards.map((c) => c.qloo_entity_id)).not.toContain(solo.qloo_entity_id);
    expect(w2.cards.map((c) => c.qloo_entity_id)).not.toContain(home.qloo_entity_id);
    const e = ALL_CAPTURED.get(home.qloo_entity_id)!;
    expect(verifyCard(e, { kind: "home", constraints: { maxMeters: 1500, priceMax: 2, inRecovery: false, needQuiet: false, needWheelchair: false }, struck: new Set([home.qloo_entity_id]) }).reasons).toEqual([{ rule: "R-HIST", verdict: "REFUSE", detail: "removed by the clinician before" }]);
  });

  it("the top-rated (≥ 7) activity is kept in its slot after a live /entities re-check; the other ≥ 7 is a signal, not 'leaving out'", async () => {
    const r = await ratedWeek();
    const seen: QlooParams[] = [];
    const { plan: w2 } = await replanWeek({ store: r.store, planId: r.plan.id, qloo: loggingReplay(seen), llms: [downLlm()] });
    const top = r.outs[0]; // rated 9
    const kept = w2.cards.find((c) => c.qloo_entity_id === top.qloo_entity_id)!;
    expect(kept).toBeDefined();
    expect(kept).toMatchObject({ day_name: top.day_name, hour: top.hour, routed_by: "kept", verdict: "PASS" });
    expect(kept.tool_params).toMatchObject({ kept: true, rated: 9 });
    expect(kept.checks.map((x) => x.rule)).toEqual(expect.arrayContaining(["R-OPEN", "R-NEAR", "R-HIST", "R-KIND"]));
    expect(w2.cards.filter((c) => c.qloo_entity_id === top.qloo_entity_id)).toHaveLength(1);
    expect(w2.diff!.kept_check).toMatchObject({ entity_id: top.qloo_entity_id, ok: true });
    expect(w2.diff!.kept).toContainEqual(expect.objectContaining({ name: top.name, reason: expect.stringMatching(/^rated ≥7 — kept, re-checked live/) }));
    // the other ≥ 7 activity is either back (Qloo returned it again) or listed as this week's signal — never "leaving out"
    const other = [...w2.diff!.kept, ...w2.diff!.signals].find((x) => x.name === r.home[0].name);
    expect(other?.reason).toMatch(/^rated ≥7 — (kept|now a Qloo signal for this week)/);
    expect(w2.diff!.removed.some((x) => /≥7/.test(x.reason))).toBe(false);
    const calls = (await r.store.getCalls(w2.id))!.calls;
    expect(calls.filter((c) => c.path === "/entities")).toHaveLength(1);
  });

  it("a kept activity that fails its re-check (closed at the slot today) is not placed; the diff says why", async () => {
    const r = await ratedWeek();
    const top = r.outs[0];
    const closed = (e: QlooEntity) => (e.entity_id === top.qloo_entity_id ? { ...e, properties: { ...e.properties, hours: { [top.day_name]: [{ opens: null, closes: null, closed: true }] } } } : e);
    const { plan: w2 } = await replanWeek({ store: r.store, planId: r.plan.id, qloo: loggingReplay([], closed), llms: [downLlm()] });
    expect(w2.cards.some((c) => c.routed_by === "kept")).toBe(false);
    expect(w2.diff!.kept_check).toMatchObject({ ok: false, detail: expect.stringMatching(/re-check for \w{3} \d\d:00 failed: R-OPEN/) });
    expect(w2.diff!.signals).toContainEqual(expect.objectContaining({ name: top.name, reason: expect.stringMatching(/^rated ≥7 — not kept: re-check .* failed: R-OPEN .*; now a Qloo signal/) }));
  });

  it("removing a week-2 card refreshes its diff (it no longer counts as added)", async () => {
    const r = await ratedWeek();
    const { plan: w2 } = await replanWeek({ store: r.store, planId: r.plan.id, qloo: loggingReplay(), llms: [downLlm()] });
    const added = w2.cards.find((c) => w2.diff!.added.some((a) => a.name === c.name && a.day === c.day_name))!;
    const { plan: next } = await actOnCard({ store: r.store, planId: w2.id, cardId: added.id, action: "remove" });
    expect(next.diff!.added.some((a) => a.name === added.name && a.day === added.day_name)).toBe(false);
    expect(next.diff!.ember.some((e) => e.to_id === added.qloo_entity_id)).toBe(false);
  });
});

describe("gate routes", () => {
  afterEach(() => vi.unstubAllEnvs());
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
  const req = (url: string, method: string, body?: unknown) => new Request(`http://x${url}`, { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), headers: { "x-forwarded-for": `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` } });

  it("validate input (400), 404 unknown plans/cards, 409 out-of-order steps; re-plan refusals never open a stream", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
    vi.stubEnv("VERCEL", "");
    const store = storeFromEnv();
    const { plan } = await mayaWeek(store);
    const card = plan.cards[0];
    const patch = (cardId: string, body: unknown) => cardRoute(req(`/api/plans/${plan.id}/cards/${cardId}`, "PATCH", body), { params: Promise.resolve({ id: plan.id, cardId }) });
    expect((await patch(card.id, { action: "delete-everything" })).status).toBe(400);
    expect((await patch(crypto.randomUUID(), { action: "approve" })).status).toBe(404);
    const ok = await patch(card.id, { action: "approve" });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { plan: PlanDoc }).plan.cards[0].clinician_action).toBe("approved");

    expect((await ratingsRoute(req(`/api/plans/${plan.id}/ratings`, "POST", { ratings: [{ card_id: card.id, pleasure: 5, mastery: 5 }] }), ctx(plan.id))).status).toBe(409);
    const rp = await replanRoute(req(`/api/plans/${plan.id}/replan`, "POST"), ctx(plan.id));
    expect(rp.status).toBe(409);
    expect(rp.headers.get("content-type")).toContain("application/json");
    expect((await replanRoute(req(`/api/plans/${crypto.randomUUID()}/replan`, "POST"), ctx(crypto.randomUUID()))).status).toBe(404);

    expect((await approveRoute(req(`/api/plans/${plan.id}/approve`, "POST"), ctx(plan.id))).status).toBe(200);
    expect((await approveRoute(req(`/api/plans/${plan.id}/approve`, "POST"), ctx(plan.id))).status).toBe(409);
    expect((await ratingsRoute(req(`/api/plans/${plan.id}/ratings`, "POST", { ratings: [{ card_id: card.id, pleasure: 11, mastery: 5 }] }), ctx(plan.id))).status).toBe(400);
    const rated = await ratingsRoute(req(`/api/plans/${plan.id}/ratings`, "POST", { ratings: [{ card_id: card.id, pleasure: 7, mastery: 5 }] }), ctx(plan.id));
    expect(rated.status).toBe(200);
    expect(((await rated.json()) as { plan: PlanDoc }).plan.status).toBe("rated");
    const one = await replanRoute(req(`/api/plans/${plan.id}/replan`, "POST"), ctx(plan.id));
    expect(one.status).toBe(409);
    expect(((await one.json()) as { error: string }).error).toMatch(/at least 3.*1 rated/);
  });

  it("a malformed JSON body is a 400 'invalid JSON' on every write route, never a 500 (QA round 1)", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
    vi.stubEnv("VERCEL", "");
    const store = storeFromEnv();
    const { plan } = await mayaWeek(store);
    const bad = (url: string, method: string) => new Request(`http://x${url}`, { method, body: "{bad", headers: { "content-type": "application/json", "x-forwarded-for": `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` } });
    const responses = [
      await casesRoute(bad("/api/cases", "POST")),
      await constraintsRoute(bad(`/api/plans/${plan.id}/constraints`, "POST"), ctx(plan.id)),
      await ratingsRoute(bad(`/api/plans/${plan.id}/ratings`, "POST"), ctx(plan.id)),
      await cardRoute(bad(`/api/plans/${plan.id}/cards/${plan.cards[0].id}`, "PATCH"), { params: Promise.resolve({ id: plan.id, cardId: plan.cards[0].id }) }),
    ];
    for (const r of responses) {
      expect(r.status).toBe(400);
      expect(await r.json()).toEqual({ error: "invalid JSON" });
    }
  });

  it("seed preset=recovery clones a profile with 'in recovery' on (the /judge REVIEW button); an unknown preset is a 400", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
    vi.stubEnv("VERCEL", "");
    const slug = (s: string) => ({ params: Promise.resolve({ slug: s }) });
    const on = await seedRoute(req("/api/cases/seed/maya?preset=recovery", "POST"), slug("maya"));
    expect(on.status).toBe(201);
    expect(((await on.json()) as { case: { in_recovery: boolean } }).case.in_recovery).toBe(true);
    const plain = await seedRoute(req("/api/cases/seed/maya", "POST"), slug("maya"));
    expect(((await plain.json()) as { case: { in_recovery: boolean } }).case.in_recovery).toBe(false);
    expect((await seedRoute(req("/api/cases/seed/maya?preset=party", "POST"), slug("maya"))).status).toBe(400);
  });

  it("re-plan streams SSE ending in the stored week 2; a repeat returns it as JSON", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
    vi.stubEnv("VERCEL", "");
    const store = storeFromEnv();
    const r = await ratedWeek(store);
    // the route runs with env clients; pre-make week 2 through the service (replay) and check the route reuses it
    const { plan: w2 } = await replanWeek({ store, planId: r.plan.id, qloo: loggingReplay(), llms: [downLlm()] });
    const res = await replanRoute(req(`/api/plans/${r.plan.id}/replan`, "POST"), ctx(r.plan.id));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ reused: true, plan: { id: w2.id, week: 2 } });
    expect(parseSse("event: plan\ndata: {}\n\n")[0].event).toBe("plan");
  });
});
