/**
 * The clinician gate and the ratings loop.
 *
 *   draft     per card: approve / unapprove / swap / remove; constraint toggles (lib/service.ts)
 *     │  approveWeek — the one "Approve week" action; nothing reaches the patient without it (I4)
 *   approved  pleasure / mastery 0–10 on approved cards
 *     │  rate — the first rating moves the week to "rated"
 *   rated     replan — needs ≥ 3 rated activities; runs the same agent loop for week N+1 with the ratings turned into
 *             Qloo signals and exclusions (lib/replan.ts), stores the diff, and links the two weeks (one re-plan per week)
 *
 * A swap re-runs ONE slot through the same tool and verifier as the agent (findAtHome / findOutings / placeSocial) with
 * every entity already on the sheet, and every entity the clinician struck, excluded. It never takes a name from the
 * model or the clinician. Swapped-out and removed cards stay on the sheet as clinician strikes (`by_clinician`).
 */
import { runAgent, templateCoaching } from "./agent";
import { llmChainFromEnv, type LlmHandle } from "./llm";
import { qlooFromEnv, type QlooCallLog, type QlooClient } from "./qloo";
import { findAtHome, findOutings, placeSocial, recheckKept, type Card, type HomeType, type SlotSpec, type ToolContext } from "./plan";
import { diffWeeks, historyFromRatings, keptCandidate, type KeptNote, type Rating } from "./replan";
import { Conflict, NotFound, reclaimableRun, refreshDiff, RUN_STALE_MS, runningConflict, type RunPlanOptions } from "./service";
import { callsDoc, cardFromDoc, cardToDoc, caseRowFromDoc, newId, PlanDoc, planDocFromAgent, weekPlanFromDoc, type CardDoc, type RefusalDoc, type Store } from "./store";

export type CardAction = "approve" | "unapprove" | "swap" | "remove";

/** The re-plan button is enabled at this many rated activities. */
export const MIN_RATED_FOR_REPLAN = 3;

type QlooFactory = (onCall: (l: QlooCallLog) => void) => QlooClient;

async function draftPlan(store: Store, planId: string): Promise<PlanDoc> {
  const plan = await store.getPlan(planId);
  if (!plan) throw new NotFound(`plan ${planId} not found`);
  if (plan.status !== "draft") throw new Conflict("this week is already approved; the clinician gate is closed");
  return plan;
}

const clinicianStrike = (planId: string, c: CardDoc, how: "swapped" | "removed"): RefusalDoc => ({
  id: newId(),
  plan_id: planId,
  qloo_entity_id: c.qloo_entity_id,
  name: c.name,
  rule: "CLINICIAN",
  detail: how === "swapped" ? "swapped out by the clinician" : "removed by the clinician",
  verdict: "REFUSE",
  day_name: c.day_name,
  hour: c.hour,
  by_clinician: how,
});

/**
 * PATCH /api/plans/:id/cards/:cardId — one clinician action on one card of a draft week. The plan is updated in place
 * (the case is unchanged, so the week stays consistent with it).
 */
export async function actOnCard(o: { store: Store; planId: string; cardId: string; action: CardAction; qloo?: QlooFactory }): Promise<{ plan: PlanDoc; swap?: { found: boolean; ms: number; calls: number } }> {
  const plan = await draftPlan(o.store, o.planId);
  const card = plan.cards.find((c) => c.id === o.cardId);
  if (!card) throw new NotFound(`card ${o.cardId} is not on this week`);

  if (o.action === "approve" || o.action === "unapprove") {
    const next = PlanDoc.parse({ ...plan, cards: plan.cards.map((c) => (c.id === card.id ? { ...c, clinician_action: o.action === "approve" ? "approved" : null } : c)) });
    await o.store.putPlan(next);
    return { plan: next };
  }

  if (o.action === "remove") {
    const next = await refreshDiff(
      o.store,
      PlanDoc.parse({
        ...plan,
        cards: plan.cards.filter((c) => c.id !== card.id),
        empty_slots: [...plan.empty_slots, { day_name: card.day_name, hour: card.slot_hour, rung: card.rung, reason: "removed by the clinician", routed_by: "clinician" }],
        refusals: [...plan.refusals, clinicianStrike(plan.id, card, "removed")],
      }),
    );
    await o.store.putPlan(next);
    return { plan: next };
  }

  // swap: re-run this one slot with the same tool + verifier, excluding everything already on (or struck from) the sheet
  const t0 = Date.now();
  const c = await o.store.getCase(plan.case_id);
  if (!c) throw new NotFound(`case ${plan.case_id} not found`);
  const calls: QlooCallLog[] = [];
  const qloo = (o.qloo ?? qlooFromEnv)((l) => calls.push(l));
  const struck = plan.refusals.filter((r) => r.by_clinician).map((r) => r.qloo_entity_id);
  const onSheet = plan.cards.map((x) => x.qloo_entity_id);
  const used = new Set([...onSheet, ...struck]);
  const places = new Set([...plan.cards.filter((x) => x.rung !== "home").map((x) => x.qloo_entity_id), ...(card.rung !== "home" ? [card.qloo_entity_id] : []), ...plan.refusals.filter((r) => r.by_clinician === "swapped").map((r) => r.qloo_entity_id)]);
  const ctx: ToolContext = { qloo, case: caseRowFromDoc(c), history: plan.history, used, usedPlaces: card.rung === "home" ? new Set() : places, seen: new Set(used) };
  const slot: SlotSpec = { day: card.day_name, hour: card.slot_hour, rung: card.rung, ...(card.home_type ? { homeType: card.home_type } : {}) };
  const homeType: HomeType = card.home_type ?? ((card.entity_type.replace("urn:entity:", "") as HomeType) || "artist");
  const tool = card.rung === "home" ? "findAtHome" : card.rung === "solo" ? "findOutings" : "placeSocial";
  const r = card.rung === "home" ? await findAtHome(ctx, { ...slot, homeType }, homeType, 10) : card.rung === "solo" ? await findOutings(ctx, slot) : await placeSocial(ctx, slot);
  const replacement = r.card ? cardToDoc(plan.id, r.card, { coaching: templateCoaching(r.card, homeType), coaching_by: "template", routed_by: "swap", tool, tool_params: { day: card.day_name, swap_of: card.qloo_entity_id } }) : null;
  const runRefusals: RefusalDoc[] = r.refusals.map((x) => ({ id: newId(), plan_id: plan.id, qloo_entity_id: x.entity_id, name: x.name, rule: x.rule, detail: x.detail, verdict: x.verdict, day_name: x.day, hour: x.hour, ...(x.movedTo !== undefined ? { moved_to: x.movedTo } : {}) }));
  const prior = (await o.store.getCalls(plan.id))?.calls ?? [];
  const merged = [...prior, ...callsDoc(plan.id, calls).calls];
  const next = await refreshDiff(
    o.store,
    PlanDoc.parse({
      ...plan,
      qloo_calls: merged.length,
      cards: replacement ? plan.cards.map((x) => (x.id === card.id ? replacement : x)) : plan.cards.filter((x) => x.id !== card.id),
      empty_slots: replacement ? plan.empty_slots : [...plan.empty_slots, { day_name: card.day_name, hour: card.slot_hour, rung: card.rung, reason: r.empty ?? "no other verified candidate", routed_by: "swap" }],
      refusals: [...plan.refusals, clinicianStrike(plan.id, card, "swapped"), ...runRefusals],
      review: [...plan.review, ...r.review.map((x) => cardToDoc(plan.id, x, { routed_by: "swap" }))],
    }),
  );
  await o.store.putPlan(next);
  await o.store.putCalls({ plan_id: plan.id, calls: merged });
  return { plan: next, swap: { found: !!replacement, ms: Date.now() - t0, calls: calls.length } };
}

/** POST /api/plans/:id/approve — the clinician gate. Every card still on the sheet is stamped; the week is locked. */
export async function approveWeek(o: { store: Store; planId: string }): Promise<PlanDoc> {
  const plan = await draftPlan(o.store, o.planId);
  if (plan.cards.length === 0) throw new Conflict("there is nothing on this week to approve");
  const next = PlanDoc.parse({ ...plan, status: "approved", approved_at: new Date().toISOString(), cards: plan.cards.map((c) => ({ ...c, clinician_action: "approved" })) });
  await o.store.putPlan(next);
  return next;
}

export interface RatingInput {
  card_id: string;
  pleasure: number;
  /** optional: a patient may score pleasure only; mastery is recorded and shown, it never changes Qloo signals */
  mastery?: number | null;
}

/** POST /api/plans/:id/ratings — pleasure / mastery 0–10 on approved cards of an approved week. */
export async function rateWeek(o: { store: Store; planId: string; ratings: RatingInput[] }): Promise<PlanDoc> {
  const plan = await o.store.getPlan(o.planId);
  if (!plan) throw new NotFound(`plan ${o.planId} not found`);
  if (plan.status === "draft") throw new Conflict("approve the week before rating it");
  if (plan.next_plan_id) throw new Conflict("this week was already re-planned; its ratings are locked");
  const byId = new Map(o.ratings.map((r) => [r.card_id, r]));
  for (const id of byId.keys()) {
    const c = plan.cards.find((x) => x.id === id);
    if (!c) throw new NotFound(`card ${id} is not on this week`);
    if (c.clinician_action !== "approved") throw new Conflict(`${c.name} was not approved, so it cannot be rated`);
  }
  const cards = plan.cards.map((c) => {
    const r = byId.get(c.id);
    return r ? { ...c, pleasure: r.pleasure, mastery: r.mastery ?? null } : c;
  });
  const next = PlanDoc.parse({ ...plan, cards, status: cards.some((c) => c.pleasure !== null) ? "rated" : "approved" });
  await o.store.putPlan(next);
  return next;
}

export const ratingsOf = (plan: PlanDoc): Rating[] => plan.cards.filter((c) => c.pleasure !== null).map((c) => ({ entity_id: c.qloo_entity_id, pleasure: c.pleasure!, mastery: c.mastery ?? 0 }));

/**
 * Everything a re-plan needs before it may spend an agent run: the week exists, and either it was already re-planned
 * (`existing`), is being re-planned right now (409 `running`, QA round 2: two tabs ran two re-plans), or it is rated
 * with ≥ 3 ratings. Routes call this before the rate limiter so a refused re-plan is a plain 404 / 409 and never
 * costs quota.
 */
export async function replanPrecheck(store: Store, planId: string, now = Date.now()): Promise<{ parent: PlanDoc; existing: PlanDoc | null }> {
  const parent = await store.getPlan(planId);
  if (!parent) throw new NotFound(`plan ${planId} not found`);
  if (parent.next_plan_id) {
    const existing = await store.getPlan(parent.next_plan_id);
    if (existing) return { parent, existing };
  }
  const run = await store.getReplanRun(planId).catch(() => null);
  if (run?.status === "done" && run.plan_id) {
    const existing = await store.getPlan(run.plan_id);
    if (existing) return { parent, existing };
  }
  if (run?.status === "running" && now - Date.parse(run.started_at) < RUN_STALE_MS) throw runningConflict("this week is already being re-planned", run);
  if (parent.status !== "rated") throw new Conflict(parent.status === "draft" ? "approve the week before re-planning it" : "rate the week before re-planning it");
  const n = ratingsOf(parent).length;
  if (n < MIN_RATED_FOR_REPLAN) throw new Conflict(`rate at least ${MIN_RATED_FOR_REPLAN} activities before re-planning (${n} rated)`);
  return { parent, existing: null };
}

/**
 * Claim the one re-plan of a rated week (create-only marker runs/replan-<id>) after replanPrecheck passed. Returns the
 * claim, the week another request already made, or throws a 409 `running` Conflict while that request is in flight.
 */
export async function claimReplan(store: Store, parent: PlanDoc, now = Date.now()): Promise<{ claimed: { started_at: string } } | { plan: PlanDoc }> {
  const started_at = new Date(now).toISOString();
  const cur = await store.claimRun({ case_id: parent.case_id, parent_plan_id: parent.id, status: "running", plan_id: null, started_at, updated_at: started_at }, reclaimableRun(now));
  if (!cur) return { claimed: { started_at } };
  if (cur.status === "done" && cur.plan_id) {
    const plan = await store.getPlan(cur.plan_id);
    if (plan) return { plan };
  }
  throw runningConflict("this week is already being re-planned", cur);
}

/**
 * POST /api/plans/:id/replan — week N+1 from the ratings, live: rated ≥ 7 → signal.interests.entities (+ place tags),
 * rated ≤ 3 → filter.exclude.entities (+ distinctive tags). Same agent loop, tools and verifier as week 1. One re-plan
 * per week: a second call returns the week already made (or waits on a 409 while it is being made), so a double click
 * or a second tab never spends a second agent run.
 */
export async function replanWeek(o: Omit<RunPlanOptions, "caseId"> & { planId: string }): Promise<{ plan: PlanDoc; reused: boolean }> {
  const { parent, existing } = await replanPrecheck(o.store, o.planId);
  if (existing) return { plan: existing, reused: true };
  let startedAt = o.claimed?.started_at;
  if (!startedAt) {
    const r = await claimReplan(o.store, parent);
    if ("plan" in r) return { plan: r.plan, reused: true };
    startedAt = r.claimed.started_at;
  }
  const mark = (status: "done" | "failed", planId: string | null = null) => o.store.putRun({ case_id: parent.case_id, parent_plan_id: parent.id, status, plan_id: planId, started_at: startedAt, updated_at: new Date().toISOString() });
  try {
    const plan = await replanRun(o, parent);
    await mark("done", plan.id);
    return { plan, reused: false };
  } catch (e) {
    await mark("failed").catch(() => {});
    throw e;
  }
}

async function replanRun(o: Omit<RunPlanOptions, "caseId"> & { planId: string }, parent: PlanDoc): Promise<PlanDoc> {
  const ratings = ratingsOf(parent);
  const c = await o.store.getCase(parent.case_id);
  if (!c) throw new NotFound(`case ${parent.case_id} not found`);
  const struck = parent.refusals.filter((r) => r.by_clinician).map((r) => r.qloo_entity_id);
  const history = historyFromRatings(parent.history, parent.cards.map(cardFromDoc), ratings, struck);
  const calls: QlooCallLog[] = [];
  const onCall = (l: QlooCallLog) => {
    calls.push(l);
    o.onEvent?.({ type: "qloo", path: l.path, status: l.status, ms: l.ms, n_results: l.n_results, params: l.params });
  };
  const qloo = (o.qloo ?? qlooFromEnv)(onCall);
  const llms: LlmHandle[] = o.llms ?? llmChainFromEnv();
  const week = parent.week + 1;
  const row = caseRowFromDoc(c);
  // BA schedules an enjoyed activity again: the top-rated (≥ 7) one keeps its slot if a live re-check passes it there
  const cand = keptCandidate(parent.cards.map(cardFromDoc), ratings);
  let pinned: { card: Card; params: Record<string, unknown> }[] = [];
  let keptNote: KeptNote | null = null;
  if (cand) {
    const k = await recheckKept(qloo, row, history, cand.card);
    keptNote = { entity_id: cand.card.entity_id, name: cand.card.name, ok: !!k.card, detail: k.detail };
    if (k.card) pinned = [{ card: k.card, params: { rated: cand.pleasure } }];
  }
  const agent = await runAgent({ qloo, case: row, week, history, llms, pinned, onEvent: (e) => e.type !== "plan" && o.onEvent?.(e) });
  const base = planDocFromAgent(agent, { caseId: c.id, history, calls: calls.length, parentPlanId: parent.id });
  const diff = diffWeeks(weekPlanFromDoc(parent), weekPlanFromDoc(base), history, keptNote);
  const doc = PlanDoc.parse({ ...base, origin: "replan", diff: { from_plan_id: parent.id, kept_check: keptNote, ...diff } });
  await o.store.putPlan(doc);
  await o.store.putCalls(callsDoc(doc.id, calls));
  await o.store.putPlan(PlanDoc.parse({ ...parent, next_plan_id: doc.id }));
  return doc;
}
