/**
 * Agent loop. A real LLM tool loop (Vercel AI SDK `generateText` + typed tools) routes the week:
 * for each slot of the energy ladder it picks the tool, the at-home domain, an optional slot hour and an optional
 * tighter radius, then writes one ≤25-word coaching line per placed card.
 *
 * Truth boundary (W4). The model chooses where to look; Qloo and lib/verify.ts decide what is true.
 *   - Tool schemas carry no constraint: recovery / quiet / wheelchair / budget / max distance come from the case row
 *     (lib/plan.ts, I6/I7). `narrowMeters` can only tighten.
 *   - Cards are assembled in code from tool outputs keyed by `entity_id`. The LLM never names a venue: its only free
 *     text is the coaching line, which is dropped (and logged) if it references an ID no tool returned this run (R-ID),
 *     runs past 25 words, names another entity seen in this run, or mentions drinking (COACH-ALC, every case).
 *   - A slot the LLM never routed is filled by the same deterministic tool (`routedBy: "fallback"`); a slot is never
 *     filled from the model's own text. If every LLM provider fails, the whole week is routed deterministically.
 */
import { generateText, stepCountIs, tool, type StopCondition, type ToolSet } from "ai";
import { z } from "zod";
import type { LlmHandle } from "./llm";
import type { QlooClient } from "./qloo";
import { EMPTY, isOutageReason, isToolFailureReason } from "./empty";
import { providerError } from "./redact";
import { DAYS, type DayName } from "./verify";
import { diagnoseEmpty, EMPTY_HISTORY, findAtHome, findOutings, HOME_TYPES, ladder, placeSocial, type Card, type Relax, type CaseRow, type HomeType, type PlanHistory, type Refusal, type SlotSpec, type ToolContext, type ToolResult, type WeekPlan } from "./plan";

/** `kept`: a re-plan keeps the top-rated (≥ 7) activity in its slot after a live re-check (lib/plan.ts recheckKept) */
export type RoutedBy = "llm" | "fallback" | "kept";
export type ToolName = "findAtHome" | "findOutings" | "placeSocial";

export interface AgentSlot {
  slot: SlotSpec;
  card: Card | null;
  empty?: string;
  routedBy: RoutedBy;
  /** routedBy "llm": the "provider:model" whose tool call routed this slot (QA 2026-10-09: the first provider used to be
   *  credited with the whole week, although Groq routed 5 of its 6 LLM slots after Qwen timed out) */
  llm?: string;
  tool: ToolName;
  params: Record<string, unknown>;
  coaching?: string;
  coachingBy?: "llm" | "template";
  /** heatmap cell of the social slot */
  cell?: string;
  /** empty outing: verified candidates per single relaxed filter (diagnoseEmpty) */
  relax?: Relax;
}

export interface Dropped {
  /** R-ID: an ID no tool returned; COACH-LENGTH / COACH-NAME: coaching line rejected */
  rule: "R-ID" | "COACH-LENGTH" | "COACH-NAME" | "COACH-FACT" | "COACH-DUPLICATE" | "COACH-ALC" | "COACH-DOSE";
  entity_id: string;
  detail: string;
}

export interface AgentPlan extends Omit<WeekPlan, "slots"> {
  slots: AgentSlot[];
  /** the LLM that routed this plan, or null when every provider failed (deterministic route) */
  llm: { provider: string; model: string } | null;
  /** the provider whose coaching call won the race (null: every card's coaching is the template) */
  coachedBy?: { provider: string; model: string } | null;
  llmSteps: number;
  llmMs: number;
  llmErrors: { provider: string; error: string }[];
  dropped: Dropped[];
  latencyMs: number;
}

export type AgentEvent =
  | { type: "start"; week: number; slots: { day: DayName; hour: number; rung: string }[]; llm: string[] }
  | { type: "llm"; provider: string; model: string; step: number; ms: number; toolCalls: string[]; finishReason: string; inputTokens: number | null; outputTokens: number | null }
  /** stage "route": a routing attempt failed (`to` = the next provider, or null: the deterministic route takes the `open`
   *  slots, if any); stage "coach": the coaching call failed, so its cards keep the template dose line */
  | { type: "llm_fallback"; from: string; to: string | null; error: string; stage?: "route" | "coach"; open?: number }
  | { type: "tool"; tool: ToolName; day: DayName; params: Record<string, unknown>; routedBy: RoutedBy; ms: number; returned: number; card: { entity_id: string; name: string; hour: number; movedFrom?: number } | null; refusals: Record<string, number>; review: number; empty?: string }
  | { type: "tool_rejected"; tool: string; day: string; reason: string }
  | { type: "truth_boundary"; dropped: Dropped[] }
  | { type: "plan"; plan: AgentPlan };

export interface AgentOptions {
  qloo: QlooClient;
  case: CaseRow;
  week?: number;
  history?: PlanHistory;
  /** LLM chain: primary first, then fallbacks. Empty → deterministic routing. */
  llms: LlmHandle[];
  onEvent?: (e: AgentEvent) => void;
  /** total budget for LLM calls (ms); tools already started keep running */
  llmBudgetMs?: number;
  /** the coaching hand-off is due this long after the routing budget ends (or after routing, if that ends later); the
   *  providers race inside it (coachRace) */
  coachBudgetMs?: number;
  maxSteps?: number;
  /** tokens one provider may spend routing (default ROUTE_TOKEN_BUDGET) */
  routeTokenBudget?: number;
  /** bench ablation only (arms B−/B−4) and the pool audit; never set on the public path */
  toolOptions?: Pick<ToolContext, "alcoholScreen" | "excludeTagSet" | "onPool">;
  /** re-plan only: verified cards placed before routing (their slots are not offered to the model) */
  pinned?: { card: Card; params?: Record<string, unknown> }[];
}

const WORD_LIMIT = 25;
/** distances, walking times and prices belong to the card (Qloo data), never to the model's prose */
const FACT_PATTERN = /\b\d+(?:[.,]\d+)?\s?(?:m|km|metres?|meters?|miles?|mi|blocks?)\b|[$€£]\s?\d|\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty)[- ]minute walk\b|\bwalk is\b[^.]*\bminutes?\b/i;
const dayEnum = z.enum(DAYS);

const fmtHour = (h: number) => `${String(h).padStart(2, "0")}:00`;
/** the coaching race is due this long after the routing budget (a2a r09: COACH_ATTEMPT_MS, a per-provider cap from
 *  before the race, had no reader left) */
export const COACH_BUDGET_MS = 6_000;
/**
 * With another provider still to try, one routing attempt may spend at most this share of the routing budget left, so a
 * primary that hangs cannot starve the fallback (20 s budget → ≤ 12 s primary, ≥ 8 s for the fallback to route).
 * QA round 4: a hung primary was aborted only at the shared deadline and the fallback never got a routing turn.
 */
export const ROUTE_ATTEMPT_SHARE = 0.6;
/**
 * Tokens (input + output, as the provider reports them) one provider may spend ROUTING one plan. Past it, the open slots
 * move to the next route and the provider stays in the coaching race. Measured 2026-10-10 on Groq's free tier
 * (gpt-oss-120b, 8,000 tokens/min): the model calls one tool per step, so routing Maya's week took 7 steps and ~10,000
 * tokens, and the coaching call that followed was rate-limited (template lines ×7). A step costs up to ~1,800 tokens and
 * the coaching call ~2,900 (spike/groq-route-budget.json), so stopping after the step that crosses 3,000 keeps routing +
 * coaching under 8,000 in the same minute. Qwen routes all seven slots in one step of parallel tool calls (~400 output
 * tokens in spike/maya-agent.json), so the primary path stays far under the budget.
 */
export const ROUTE_TOKEN_BUDGET = 3_000;

/** Deterministic dose line, used when the LLM gave none (or its line was dropped). */
export function templateCoaching(card: Card, homeType?: HomeType): string {
  if (card.rung === "home") {
    const t = homeType ?? (card.entityType.replace("urn:entity:", "") as HomeType);
    if (t === "artist") return `Put on one ${card.name} song you choose and give it ten minutes.`;
    if (t === "podcast") return `Play ten minutes of one ${card.name} episode you pick.`;
    if (t === "book") return `Read ten minutes of ${card.name}, any page you like.`;
    return `Watch ten minutes of one ${card.name} episode you choose.`;
  }
  if (card.rung === "social") return `Drop by ${card.name} at ${fmtHour(card.hour)}; a short visit counts.`;
  return `Go to ${card.name} at ${fmtHour(card.hour)}; twenty minutes is enough.`;
}

/**
 * COACH-ALC: drinking language in a coaching line. The model is never told a patient is in recovery (constraints stay
 * out of the prompt), so it cannot be trusted to avoid "sit with a drink" (QA, live: Maya in recovery, Mon card). The
 * screen runs on every case — a dropped line falls back to the template dose, which costs nothing — and again over every
 * card when a constraint toggle switches "in recovery" on. The card's own name is removed first ("Ten Tea Bar").
 */
const COACH_ALC = /\b(?:drinks?|drinking|booze|boozy|beers?|wines?|cocktails?|bars?|pubs?|taverns?|brewery|breweries|taproom|happy[- ]hour|glass of|pint|shots?|toast(?:ing)?|cheers|liquor|alcohol(?:ic)?|tipsy|nightcap|prosecco|champagne|whiske?y|vodka|gin|rum|tequila|cider|lager|ale|mimosa|margarita|sangria)\b/i;
export function coachingAlcohol(line: string, ownName = ""): string | null {
  let text = line;
  if (ownName.trim()) text = text.split(new RegExp(ownName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi")).join(" ");
  return COACH_ALC.exec(text)?.[0] ?? null;
}

/**
 * COACH-DOSE: the card owns the dose. An at-home card is a 10-minute dose (its header says "10 MIN"), so a line that
 * names any other duration contradicts the card; an outing's template dose is twenty minutes, so a line may name a
 * shorter visit but not a longer one (QA round 3: header "10 MIN", line "for 20 minutes").
 */
const NUM_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, ten: 10, fifteen: 15, twenty: 20, thirty: 30, "forty-five": 45, "forty five": 45, sixty: 60, ninety: 90 };
const DURATION = /\b(\d+(?:\.\d+)?|a|an|one|two|three|four|five|ten|fifteen|twenty|thirty|forty[- ]five|sixty|ninety)[\s-]*(min(?:ute)?s?|hours?|hrs?)\b/gi;
export const DOSE_MINUTES = { home: 10, outingMax: 20 } as const;

/** Every duration a line names, in minutes ("half an hour" → 30, "an hour" → 60, "20-minute" → 20). */
export function namedMinutes(line: string): number[] {
  const out: number[] = [];
  for (const m of line.replace(/\bhalf an? hour\b/gi, "30 minutes").matchAll(DURATION)) {
    const n = m[1]!.toLowerCase();
    const v = /^\d/.test(n) ? Number(n) : NUM_WORDS[n.replace("-", " ")] ?? NUM_WORDS[n];
    if (v === undefined) continue;
    out.push(/^h/i.test(m[2]!) ? v * 60 : v);
  }
  return out;
}

/** The first named duration that contradicts the card's dose, or null. */
export function doseConflict(line: string, rung: "home" | "solo" | "social"): number | null {
  for (const m of namedMinutes(line)) {
    if (rung === "home" ? m !== DOSE_MINUTES.home : m > DOSE_MINUTES.outingMax) return m;
  }
  return null;
}

export const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

type CoachedCard = Pick<Card, "entity_id" | "name" | "rung">;
const boundaryNames = (otherNames: Iterable<string>) => [...new Set(otherNames)].filter((n) => n.trim().length >= 4);

/** The per-line rules of the truth boundary (length, fact, dose, drinking, another entity's name), or null: usable. */
function lineFault(card: CoachedCard, text: string, names: string[]): Omit<Dropped, "entity_id"> | null {
  if (!text || wordCount(text) > WORD_LIMIT) return { rule: "COACH-LENGTH", detail: `coaching line has ${wordCount(text)} words (limit ${WORD_LIMIT})` };
  const fact = FACT_PATTERN.exec(text);
  if (fact) return { rule: "COACH-FACT", detail: `coaching line states a fact the card owns ("${fact[0]}")` };
  const dose = doseConflict(text, card.rung);
  if (dose !== null) return { rule: "COACH-DOSE", detail: `coaching line names ${dose} minutes; the card's dose is ${card.rung === "home" ? `${DOSE_MINUTES.home} minutes` : `at most ${DOSE_MINUTES.outingMax} minutes`}` };
  const alc = coachingAlcohol(text, card.name);
  if (alc) return { rule: "COACH-ALC", detail: `coaching line mentions drinking ("${alc}")` };
  const lower = text.toLowerCase();
  const own = card.name.toLowerCase();
  const named = names.find((n) => n.toLowerCase() !== own && !own.includes(n.toLowerCase()) && lower.includes(n.toLowerCase()));
  if (named) return { rule: "COACH-NAME", detail: `coaching line names another entity ("${named}")` };
  return null;
}

/**
 * The lines the truth boundary would keep: keyed to one of `cards` and passing every per-line rule. Pure (nothing is
 * recorded), so the coaching race can use it as its `accept` (a2a r10: a fast call whose every line the boundary drops,
 * e.g. all COACH-ALC, used to win the race and leave the week on templates).
 */
export function usableLines(cards: CoachedCard[], lines: { entity_id: string; line: string }[], otherNames: Iterable<string>) {
  const byId = new Map(cards.map((c) => [c.entity_id, c]));
  const names = boundaryNames(otherNames);
  return lines.filter((l) => {
    const c = byId.get(l.entity_id);
    return !!c && !lineFault(c, l.line.trim(), names);
  });
}

/**
 * Truth-boundary assembler for coaching lines: keeps only lines keyed to a card placed in this run, ≤25 words, that
 * name no other entity seen in the run. Everything else is dropped and logged.
 */
export function assembleCoaching(slots: AgentSlot[], submitted: { entity_id: string; line: string }[], otherNames: Iterable<string>): Dropped[] {
  const dropped: Dropped[] = [];
  const byId = new Map(slots.filter((s) => s.card).map((s) => [s.card!.entity_id, s]));
  const names = boundaryNames(otherNames);
  for (const { entity_id, line } of submitted) {
    const s = byId.get(entity_id);
    if (!s) {
      dropped.push({ rule: "R-ID", entity_id, detail: "coaching line references an ID no tool returned this run" });
      continue;
    }
    if (s.coachingBy === "llm") {
      dropped.push({ rule: "COACH-DUPLICATE", entity_id, detail: "second coaching line for the same card" });
      continue;
    }
    const text = line.trim();
    const fault = lineFault(s.card!, text, names);
    if (fault) {
      dropped.push({ ...fault, entity_id });
      continue;
    }
    s.coaching = text;
    s.coachingBy = "llm";
  }
  for (const s of slots) {
    if (s.card && !s.coaching) {
      s.coaching = templateCoaching(s.card, s.slot.homeType);
      s.coachingBy = "template";
    }
  }
  return dropped;
}

function countBy<T>(xs: T[], key: (x: T) => string): Record<string, number> {
  return xs.reduce<Record<string, number>>((a, x) => ((a[key(x)] = (a[key(x)] ?? 0) + 1), a), {});
}

function whyText(c: Card) {
  return c.why.map((w) => `${w.name} ${w.score.toFixed(2)}`).join(" · ");
}

const ROLE = [
  "You are the routing step of Rekindle, a behavioural-activation planning agent a clinician uses with a patient.",
  "You never name, invent or recommend venues, artists, books, podcasts or shows yourself. Every activity comes from a tool result, and only entity_ids from tool results exist.",
];
const ROUTE_STEP = [
  "Step 1: fill every open slot of the ladder by calling exactly one tool per slot. Call them all at once, in parallel.",
  "- home slots → findAtHome: choose the domain (artist, podcast, book, tv_show) that best fits the patient's loves; vary domains across the week.",
  "- solo slots → findOutings: keep the suggested hour unless a different hour suits a low-energy day; narrowMeters may only tighten the walk.",
  "- the social slot → placeSocial.",
];
const COACH_STEP = [
  "Step 2: call submitPlan once with one coaching line per placed card: at most 25 words, second person, warm and concrete, a small dose: an at-home card is a ten-minute dose (never name another duration), an outing at most twenty minutes (e.g. 'listen to one song you choose', 'twenty minutes there is enough'). No clinical or efficacy claims. Do not mention any name other than that card's own name. Do not state distances, walking times, prices or opening hours: the card already shows Qloo's data.",
];

/**
 * System prompt per stage. a2a r10: routing used to carry Step 2 too, telling the model to call a submitPlan that
 * routing does not offer (refused as an unknown tool) and spending its 498 characters (~100+ input tokens) per routing step against
 * ROUTE_TOKEN_BUDGET; the coaching call carried Step 1's three routing tools it cannot call.
 */
export function systemPrompt(stage: "route" | "coach" = "route"): string {
  return [...ROLE, ...(stage === "route" ? ROUTE_STEP : COACH_STEP)].join("\n");
}

export function userPrompt(c: CaseRow, week: number, history: PlanHistory, open: SlotSpec[]): string {
  const loves = c.loves.map((l) => `${l.name ?? l.text} (${l.kind === "tag" ? "food/activity tag" : (l.entityType ?? "entity").replace("urn:entity:", "")})`).join(", ");
  const rek = history.rekindled.length ? `\nRated as enjoyed last week (now extra taste signals): ${history.rekindled.map((r) => r.name).join(", ")}.` : "";
  const slots = open.map((s) => `- ${s.day} ${fmtHour(s.hour)} ${s.rung}${s.homeType ? ` (suggested domain: ${s.homeType})` : ""}`).join("\n");
  return `Week ${week}. Energy ${c.energy} of 3 (1 = low).\nPast loves: ${loves}.${rek}\nOpen slots:\n${slots}`;
}

/** Run the agent for one week. Emits events as it goes; returns the assembled plan. */
export async function runAgent(opts: AgentOptions): Promise<AgentPlan> {
  const t0 = Date.now();
  const week = opts.week ?? 1;
  const history = opts.history ?? EMPTY_HISTORY;
  const c = opts.case;
  const emit = opts.onEvent ?? (() => {});
  const ctx: ToolContext = { qloo: opts.qloo, case: c, history, used: new Set(), usedPlaces: new Set(), seen: new Set(), ...(opts.toolOptions ?? {}) };
  const skeleton = ladder(c.energy);
  const filled = new Map<DayName, AgentSlot>();
  const claimed = new Set<DayName>();
  const pending = new Set<DayName>();
  /** a2a r09: slots the model's own tool calls claimed, retries of a Qloo-unavailable slot included. Kept (pinned) cards
   *  and the deterministic route never pass through claim(), so this, not claimed.size, says "the model routed": a kept
   *  card used to credit a provider that failed before any tool call, and a retry (claimed.size unchanged) read as "no
   *  tool called", which cost the provider its coaching seat */
  let llmClaims = 0;
  const refusals: Refusal[] = [];
  const review: Card[] = [];
  const otherNames = new Set<string>();
  let submitted: { entity_id: string; line: string }[] = [];

  emit({ type: "start", week, slots: skeleton.map((s) => ({ day: s.day, hour: s.hour, rung: s.rung })), llm: opts.llms.map((l) => `${l.provider}:${l.modelId}`) });

  // re-plan: the kept activity takes its own slot before the model routes anything (same day, same rung)
  for (const p of opts.pinned ?? []) {
    const slot = skeleton.find((s) => s.day === p.card.slot.day && s.rung === p.card.rung);
    if (!slot || claimed.has(slot.day)) continue;
    const at: SlotSpec = { ...slot, ...(p.card.slot.homeType ? { homeType: p.card.slot.homeType } : {}) };
    const card: Card = { ...p.card, slot: at };
    claimed.add(slot.day);
    ctx.used.add(card.entity_id);
    ctx.seen.add(card.entity_id);
    if (card.rung !== "home") ctx.usedPlaces?.add(card.entity_id);
    const toolName: ToolName = slot.rung === "home" ? "findAtHome" : slot.rung === "solo" ? "findOutings" : "placeSocial";
    const params = { day: slot.day, kept: true, ...(p.params ?? {}) };
    filled.set(slot.day, { slot: at, card, routedBy: "kept", tool: toolName, params });
    emit({ type: "tool", tool: toolName, day: slot.day, params, routedBy: "kept", ms: 0, returned: 1, card: { entity_id: card.entity_id, name: card.name, hour: card.hour }, refusals: {}, review: 0 });
  }

  const record = (slot: SlotSpec, toolName: ToolName, params: Record<string, unknown>, r: ToolResult & { cell?: string }, routedBy: RoutedBy, ms: number, llm?: string) => {
    refusals.push(...r.refusals);
    review.push(...r.review);
    for (const x of r.refusals) otherNames.add(x.name);
    for (const x of r.review) otherNames.add(x.name);
    const s: AgentSlot = { slot, card: r.card, routedBy, ...(llm ? { llm } : {}), tool: toolName, params, ...(r.card ? {} : { empty: r.empty ?? "no verified candidate" }), ...(r.cell ? { cell: r.cell } : {}) };
    filled.set(slot.day, s);
    emit({
      type: "tool",
      tool: toolName,
      day: slot.day,
      params,
      routedBy,
      ms,
      returned: r.returned,
      card: r.card ? { entity_id: r.card.entity_id, name: r.card.name, hour: r.card.hour, ...(r.card.movedFrom !== undefined ? { movedFrom: r.card.movedFrom } : {}) } : null,
      refusals: countBy(r.refusals, (x) => x.rule),
      review: r.review.length,
      ...(r.card ? {} : { empty: r.empty }),
    });
    return s;
  };

  /** Shared by the LLM tools and the deterministic fallback, so both paths run the same verifier. */
  const runSlot = async (slot: SlotSpec, toolName: ToolName, params: Record<string, unknown>, routedBy: RoutedBy, llm?: string) => {
    const t = Date.now();
    let r: ToolResult & { cell?: string };
    try {
      if (toolName === "findAtHome") r = await findAtHome(ctx, slot, slot.homeType!, (params.take as number | undefined) ?? 5);
      else if (toolName === "findOutings") r = await findOutings(ctx, slot, { narrowMeters: params.narrowMeters as number | undefined });
      else r = await placeSocial(ctx, slot);
    } catch (e) {
      // QA round 4: the AI SDK turns a throwing execute() into a tool-error part and carries on, so a throw here used to
      // leave the day `pending`, never `filled`, and dropped from the week (the deterministic route threw the whole run)
      r = { card: null, refusals: [], review: [], returned: 0, empty: `${EMPTY.toolFailed} (${e instanceof Error ? e.name : "error"}) — slot left empty` };
    } finally {
      pending.delete(slot.day);
    }
    return record(slot, toolName, params, r, routedBy, Date.now() - t, llm);
  };

  /** a slot left empty only because Qloo was unavailable may be routed again */
  const retryable = (day: DayName) => {
    const f = filled.get(day);
    return !pending.has(day) && !!f && !f.card && isOutageReason(f.empty);
  };
  const allRouted = () => skeleton.every((s) => claimed.has(s.day) && !retryable(s.day));

  const claim = (toolName: ToolName, day: DayName, rung: SlotSpec["rung"]): SlotSpec | { error: string } => {
    const slot = skeleton.find((s) => s.day === day);
    let error: string | null = null;
    if (!slot) error = `${day} is not in this week's ladder`;
    else if (slot.rung !== rung) error = `${day} is a ${slot.rung} slot, not ${rung}`;
    else if (claimed.has(day) && !retryable(day)) error = `${day} is already filled`;
    if (error) {
      emit({ type: "tool_rejected", tool: toolName, day, reason: error });
      return { error };
    }
    claimed.add(day);
    pending.add(day);
    llmClaims++;
    return slot!;
  };

  const summary = (s: AgentSlot) =>
    s.card
      ? { ok: true, day: s.slot.day, entity_id: s.card.entity_id, name: s.card.name, type: s.card.entityType, hour: fmtHour(s.card.hour), ...(s.card.movedFrom !== undefined ? { movedFrom: fmtHour(s.card.movedFrom) } : {}), ...(s.card.distance_m !== undefined ? { distance_m: s.card.distance_m } : {}), because: whyText(s.card) }
      : { ok: false, day: s.slot.day, empty: s.empty };

  /** the provider whose routing attempt is running: a tool call records it when it starts (an aborted attempt's calls
   *  already in flight keep the provider that made them) */
  let routing: string | undefined;

  const tools = {
    findAtHome: tool({
      description: "Fill a home slot with a 10-minute at-home dose: Qloo picks one entity of the chosen domain from the patient's taste signals.",
      inputSchema: z.object({ day: dayEnum, type: z.enum(HOME_TYPES as unknown as [HomeType, ...HomeType[]]), take: z.number().int().min(3).max(10).optional() }),
      execute: async ({ day, type, take }) => {
        const by = routing;
        const slot = claim("findAtHome", day, "home");
        if ("error" in slot) return { ok: false, error: slot.error };
        return summary(await runSlot({ ...slot, homeType: type }, "findAtHome", { day, type, ...(take ? { take } : {}) }, "llm", by));
      },
    }),
    findOutings: tool({
      description: "Fill a solo slot with a verified place: open at the hour and checked by the server against the case row (the model cannot see or change those checks).",
      inputSchema: z.object({ day: dayEnum, hour: z.number().int().min(8).max(21).optional(), narrowMeters: z.number().int().min(300).max(5000).optional() }),
      execute: async ({ day, hour, narrowMeters }) => {
        const by = routing;
        const slot = claim("findOutings", day, "solo");
        if ("error" in slot) return { ok: false, error: slot.error };
        return summary(await runSlot({ ...slot, hour: hour ?? slot.hour }, "findOutings", { day, ...(hour ? { hour } : {}), ...(narrowMeters ? { narrowMeters } : {}) }, "llm", by));
      },
    }),
    placeSocial: tool({
      description: "Fill the social slot: Qloo's heatmap finds where people with the same taste gather near the patient, then a verified place there.",
      inputSchema: z.object({ day: dayEnum, hour: z.number().int().min(8).max(21).optional() }),
      execute: async ({ day, hour }) => {
        const by = routing;
        const slot = claim("placeSocial", day, "social");
        if ("error" in slot) return { ok: false, error: slot.error };
        return summary(await runSlot({ ...slot, hour: hour ?? slot.hour }, "placeSocial", { day, ...(hour ? { hour } : {}) }, "llm", by));
      },
    }),
  } satisfies ToolSet;
  // a2a r10: routing has no submitPlan. It was never an active tool here, so a routing-time call was refused as an
  // unknown tool and the race's `submitCalls === 0` gate was always true; coaching comes only from coachRace below.

  // routing stops once every slot is routed: the coaching hand-off is its own bounded call (below), so a slow provider
  // that spent the routing budget cannot also take the coaching with it (QA round 2: 20 s timeout → template ×7)
  const routedStop: StopCondition<typeof tools> = () => allRouted();

  let routedBy: { provider: string; model: string } | null = null;
  let coachedBy: { provider: string; model: string } | null = null;
  let llmSteps = 0;
  let llmMs = 0;
  const llmErrors: { provider: string; error: string }[] = [];
  // 20 s for routing leaves room for the coaching window and the deterministic fallback inside the 30 s plan gate
  const deadline = t0 + (opts.llmBudgetMs ?? 20_000);

  const tokensSpent = new Map<LlmHandle, number>();
  const routeTokenBudget = opts.routeTokenBudget ?? ROUTE_TOKEN_BUDGET;
  const onCallEnd = (llm: LlmHandle) => (e: { performance: { responseTimeMs: number }; content: readonly { type: string; toolName?: string }[]; finishReason: unknown; usage: { inputTokens?: number; outputTokens?: number } }) => {
    const ms = Math.round(e.performance.responseTimeMs);
    tokensSpent.set(llm, (tokensSpent.get(llm) ?? 0) + (e.usage.inputTokens ?? 0) + (e.usage.outputTokens ?? 0));
    llmSteps++;
    llmMs += ms;
    const toolCalls = e.content.flatMap((part) => (part.type === "tool-call" && part.toolName ? [part.toolName] : []));
    emit({ type: "llm", provider: llm.provider, model: llm.modelId, step: llmSteps, ms, toolCalls, finishReason: String(e.finishReason), inputTokens: e.usage.inputTokens ?? null, outputTokens: e.usage.outputTokens ?? null });
  };
  const failed = new Set<LlmHandle>();
  const fail = (llm: LlmHandle, e: unknown, next: LlmHandle | undefined) => {
    const error = providerError(e);
    llmErrors.push({ provider: llm.provider, error });
    failed.add(llm);
    const open = skeleton.filter((s) => !claimed.has(s.day) || retryable(s.day)).length;
    emit({ type: "llm_fallback", from: `${llm.provider}:${llm.modelId}`, to: next ? `${next.provider}:${next.modelId}` : null, error, stage: "route", open });
  };

  // Walk the provider chain for ROUTING. A provider that makes progress but stops early (e.g. one tool per step until
  // the step cap) gets another round for the slots still open; a provider that errors or calls no tool hands over to
  // the next one.
  let i = 0;
  let rounds = 0;
  while (i < opts.llms.length && rounds < opts.llms.length + 2) {
    rounds++;
    const llm = opts.llms[i];
    routing = `${llm.provider}:${llm.modelId}`;
    const open = skeleton.filter((s) => !claimed.has(s.day) || retryable(s.day));
    if (!open.length) break;
    const remaining = deadline - Date.now();
    if (remaining < 2000) break;
    const attemptMs = i < opts.llms.length - 1 ? Math.max(2000, Math.floor(remaining * ROUTE_ATTEMPT_SHARE)) : remaining;
    const overBudget = () => (tokensSpent.get(llm) ?? 0) >= routeTokenBudget;
    const before = llmClaims;
    try {
      await generateText({
        model: llm.model,
        system: systemPrompt(),
        prompt: userPrompt(c, week, history, open) + (filled.size ? `\nAlready placed (keep):\n${[...filled.values()].filter((f) => f.card).map((f) => JSON.stringify(summary(f))).join("\n")}` : ""),
        tools,
        stopWhen: [stepCountIs(opts.maxSteps ?? 10), routedStop, overBudget],
        maxRetries: 1,
        temperature: 0.2,
        abortSignal: AbortSignal.timeout(attemptMs),
        onLanguageModelCallEnd: onCallEnd(llm),
      });
      if (!routedBy && llmClaims > before) routedBy = { provider: llm.provider, model: llm.modelId };
      if (allRouted()) break;
      if (llmClaims === before) throw new Error("the model made no progress (no tool called)");
      if (overBudget()) {
        // not a failure: the provider keeps its place in the coaching race, the open slots move on
        const next = opts.llms[i + 1];
        const open = skeleton.filter((s) => !claimed.has(s.day) || retryable(s.day)).length;
        emit({ type: "llm_fallback", from: `${llm.provider}:${llm.modelId}`, to: next ? `${next.provider}:${next.modelId}` : null, error: `token budget: ${tokensSpent.get(llm)} routing tokens spent (budget ${routeTokenBudget}); the coaching call keeps its share of the per-minute limit`, stage: "route", open });
        i++;
      }
    } catch (e) {
      if (!routedBy && llmClaims > before) routedBy = { provider: llm.provider, model: llm.modelId };
      fail(llm, e, opts.llms[i + 1]);
      i++;
    }
  }

  // Deterministic fallback for any slot the LLM never routed: same tools, same verifier, never the model's own text.
  // a2a r01: run in parallel like the LLM's own tool calls (the Qloo client's gate bounds concurrency, and ctx.used is
  // checked and claimed synchronously after each response). Sequentially, this path (the one a hung or failed LLM lands
  // on) paid every slot's Qloo latency back to back after the routing budget was already spent.
  const unrouted = skeleton.filter((slot) => !claimed.has(slot.day));
  for (const slot of unrouted) claimed.add(slot.day);
  await Promise.all(
    unrouted.map((slot) => {
      const toolName: ToolName = slot.rung === "home" ? "findAtHome" : slot.rung === "solo" ? "findOutings" : "placeSocial";
      return runSlot(slot, toolName, { day: slot.day, ...(slot.homeType ? { type: slot.homeType } : {}) }, "fallback");
    }),
  );

  // The coaching hand-off: the providers that did not fail above RACE one forced submitPlan call each inside the
  // coaching window; the first valid call wins and the others are aborted. QA round 3: sequentially, Qwen timed out on
  // every sampled run, so Groq got only what was left of the window and often templated the whole week too.
  const placed = [...filled.values()].filter((f) => f.card);
  const coachDeadline = Math.max(deadline, Date.now()) + (opts.coachBudgetMs ?? COACH_BUDGET_MS);
  const coaches = opts.llms.filter((l) => !failed.has(l));
  if (placed.length && coaches.length) {
    const cards = placed.map((s) => s.card!);
    const names = [...otherNames, ...cards.map((c) => c.name)];
    const r = await coachRace({ llms: coaches, prompt: `All slots are filled:\n${placed.map((s) => JSON.stringify(summary(s))).join("\n")}\nCall submitPlan now.`, windowMs: coachDeadline - Date.now(), onCallEnd, accept: (lines) => usableLines(cards, lines, names).length > 0 });
    submitted = r.lines ?? r.rejected;
    if (r.lines) coachedBy = r.by ? { provider: r.by.provider, model: r.by.modelId } : null;
    for (const e of r.errors) {
      llmErrors.push(e);
      emit({ type: "llm_fallback", from: e.from, to: null, error: e.error, stage: "coach" });
    }
  }

  // an outing left empty under optional filters: one live probe says which single relaxation would fill it, so the
  // coverage notice can name the binding filter and offer that relaxation (QA round 2: "widen" could not help Cal)
  // advisory probes: one that fails must not discard a finished week
  await Promise.allSettled(
    skeleton.map(async (s) => {
      const f = filled.get(s.day);
      if (!f || f.card || s.rung === "home" || isOutageReason(f.empty) || isToolFailureReason(f.empty)) return;
      const relax = await diagnoseEmpty(ctx, s);
      if (relax) f.relax = relax;
    }),
  );

  // every ladder day stays on the week, with a reason when it has no card (never dropped silently)
  const slots: AgentSlot[] = skeleton.map(
    (s) => filled.get(s.day) ?? { slot: s, card: null, empty: `${EMPTY.notRouted}: its tool call did not finish`, routedBy: "fallback", tool: s.rung === "home" ? "findAtHome" : s.rung === "solo" ? "findOutings" : "placeSocial", params: { day: s.day } },
  );
  for (const s of slots) if (s.card) otherNames.add(s.card.name);
  const dropped = assembleCoaching(slots, submitted, otherNames);
  if (dropped.length) emit({ type: "truth_boundary", dropped });

  const plan: AgentPlan = { week, slots, refusals, review, calls: [], llm: routedBy, coachedBy, llmSteps, llmMs, llmErrors, dropped, latencyMs: Date.now() - t0 };
  emit({ type: "plan", plan });
  return plan;
}

type CallEnd = (llm: LlmHandle) => (e: { performance: { responseTimeMs: number }; content: readonly { type: string; toolName?: string }[]; finishReason: unknown; usage: { inputTokens?: number; outputTokens?: number } }) => void;

const coachingSchema = z.object({ coaching: z.array(z.object({ entity_id: z.string(), line: z.string() })).max(14) });

/**
 * Race the providers for one forced submitPlan call inside `windowMs`. Each provider gets its own submitPlan tool (so
 * a loser's late call can never add lines), the first provider whose call returns lines wins and the rest are
 * aborted. Errors are reported only when no provider won (an aborted loser is not a failure). `accept` (a2a r09): a
 * call it rejects (e.g. `coaching: []`, or lines keyed only to IDs no card carries) is a failed attempt, not a win, so
 * it cannot abort a provider still writing usable lines. Callers pass `usableLines(...).length > 0` (a2a r10), the
 * same predicate the truth boundary applies after the race, so a call whose every line would be dropped cannot win.
 * `rejected`: when no call won, the lines of the rejected calls, so the boundary still logs why each was dropped.
 */
export async function coachRace(o: { llms: LlmHandle[]; prompt: string; windowMs: number; onCallEnd?: CallEnd; accept?: (lines: { entity_id: string; line: string }[]) => boolean }): Promise<{ lines: { entity_id: string; line: string }[] | null; by: LlmHandle | null; errors: { provider: string; from: string; error: string }[]; rejected: { entity_id: string; line: string }[] }> {
  if (!o.llms.length || o.windowMs < 1500) return { lines: null, by: null, errors: [], rejected: [] };
  const rejected: { entity_id: string; line: string }[] = [];
  const won = new AbortController();
  const signal = AbortSignal.any([AbortSignal.timeout(o.windowMs), won.signal]);
  const attempt = async (llm: LlmHandle) => {
    let got: { entity_id: string; line: string }[] | null = null;
    const tools = {
      submitPlan: tool({
        description: "Finish: one coaching line (≤25 words) per placed card, keyed by the entity_id a tool returned.",
        inputSchema: coachingSchema,
        execute: async ({ coaching }) => {
          got = coaching;
          return { ok: true };
        },
      }),
    } satisfies ToolSet;
    await generateText({
      model: llm.model,
      system: systemPrompt("coach"),
      prompt: o.prompt,
      tools,
      toolChoice: { type: "tool", toolName: "submitPlan" },
      stopWhen: stepCountIs(1),
      maxRetries: 0,
      temperature: 0.2,
      abortSignal: signal,
      ...(o.onCallEnd ? { onLanguageModelCallEnd: o.onCallEnd(llm) } : {}),
    });
    if (!got) throw new Error("the model did not call submitPlan");
    if (o.accept && !o.accept(got)) {
      rejected.push(...(got as { entity_id: string; line: string }[]));
      throw new Error("the model's submitPlan had no usable line for a placed card");
    }
    won.abort();
    return { llm, lines: got as { entity_id: string; line: string }[] };
  };
  const runs = o.llms.map(attempt);
  try {
    const r = await Promise.any(runs);
    return { lines: r.lines, by: r.llm, errors: [], rejected: [] };
  } catch {
    const settled = await Promise.allSettled(runs);
    return {
      lines: null,
      by: null,
      rejected,
      errors: settled.flatMap((x, k) => (x.status === "rejected" ? [{ provider: o.llms[k]!.provider, from: `${o.llms[k]!.provider}:${o.llms[k]!.modelId}`, error: providerError(x.reason) }] : [])),
    };
  }
}

/** I1 check used by tests and scripts: every card carries a Qloo entity_id returned in this run. */
export function cardsWithoutEntity(plan: AgentPlan): number {
  return plan.slots.filter((s) => s.card && !s.card.entity_id).length;
}
