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
import { DAYS, type DayName } from "./verify";
import { EMPTY_HISTORY, findAtHome, findOutings, HOME_TYPES, ladder, placeSocial, type Card, type CaseRow, type HomeType, type PlanHistory, type Refusal, type SlotSpec, type ToolContext, type ToolResult, type WeekPlan } from "./plan";

/** `kept`: a re-plan keeps the top-rated (≥ 7) activity in its slot after a live re-check (lib/plan.ts recheckKept) */
export type RoutedBy = "llm" | "fallback" | "kept";
export type ToolName = "findAtHome" | "findOutings" | "placeSocial";

export interface AgentSlot {
  slot: SlotSpec;
  card: Card | null;
  empty?: string;
  routedBy: RoutedBy;
  tool: ToolName;
  params: Record<string, unknown>;
  coaching?: string;
  coachingBy?: "llm" | "template";
  /** heatmap cell of the social slot */
  cell?: string;
}

export interface Dropped {
  /** R-ID: an ID no tool returned; COACH-LENGTH / COACH-NAME: coaching line rejected */
  rule: "R-ID" | "COACH-LENGTH" | "COACH-NAME" | "COACH-FACT" | "COACH-DUPLICATE" | "COACH-ALC";
  entity_id: string;
  detail: string;
}

export interface AgentPlan extends Omit<WeekPlan, "slots"> {
  slots: AgentSlot[];
  /** the LLM that routed this plan, or null when every provider failed (deterministic route) */
  llm: { provider: string; model: string } | null;
  llmSteps: number;
  llmMs: number;
  llmErrors: { provider: string; error: string }[];
  dropped: Dropped[];
  latencyMs: number;
}

export type AgentEvent =
  | { type: "start"; week: number; slots: { day: DayName; hour: number; rung: string }[]; llm: string[] }
  | { type: "llm"; provider: string; model: string; step: number; ms: number; toolCalls: string[]; finishReason: string; outputTokens: number | null }
  | { type: "llm_fallback"; from: string; to: string | null; error: string }
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
  maxSteps?: number;
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

export const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

/**
 * Truth-boundary assembler for coaching lines: keeps only lines keyed to a card placed in this run, ≤25 words, that
 * name no other entity seen in the run. Everything else is dropped and logged.
 */
export function assembleCoaching(slots: AgentSlot[], submitted: { entity_id: string; line: string }[], otherNames: Iterable<string>): Dropped[] {
  const dropped: Dropped[] = [];
  const byId = new Map(slots.filter((s) => s.card).map((s) => [s.card!.entity_id, s]));
  const names = [...new Set(otherNames)].filter((n) => n.trim().length >= 4);
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
    if (!text || wordCount(text) > WORD_LIMIT) {
      dropped.push({ rule: "COACH-LENGTH", entity_id, detail: `coaching line has ${wordCount(text)} words (limit ${WORD_LIMIT})` });
      continue;
    }
    const fact = FACT_PATTERN.exec(text);
    if (fact) {
      dropped.push({ rule: "COACH-FACT", entity_id, detail: `coaching line states a fact the card owns ("${fact[0]}")` });
      continue;
    }
    const alc = coachingAlcohol(text, s.card!.name);
    if (alc) {
      dropped.push({ rule: "COACH-ALC", entity_id, detail: `coaching line mentions drinking ("${alc}")` });
      continue;
    }
    const lower = text.toLowerCase();
    const own = s.card!.name.toLowerCase();
    const named = names.find((n) => n.toLowerCase() !== own && !own.includes(n.toLowerCase()) && lower.includes(n.toLowerCase()));
    if (named) {
      dropped.push({ rule: "COACH-NAME", entity_id, detail: `coaching line names another entity ("${named}")` });
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

export function systemPrompt(): string {
  return [
    "You are the routing step of Rekindle, a behavioural-activation planning agent a clinician uses with a patient.",
    "You never name, invent or recommend venues, artists, books, podcasts or shows yourself. Every activity comes from a tool result, and only entity_ids from tool results exist.",
    "Step 1: fill every open slot of the ladder by calling exactly one tool per slot. Call them all at once, in parallel.",
    "- home slots → findAtHome: choose the domain (artist, podcast, book, tv_show) that best fits the patient's loves; vary domains across the week.",
    "- solo slots → findOutings: keep the suggested hour unless a different hour suits a low-energy day; narrowMeters may only tighten the walk.",
    "- the social slot → placeSocial.",
    "Step 2: call submitPlan once with one coaching line per placed card: at most 25 words, second person, warm and concrete, a small dose (e.g. 'listen to one song you choose', 'twenty minutes is enough'). No clinical or efficacy claims. Do not mention any name other than that card's own name. Do not state distances, walking times, prices or opening hours: the card already shows Qloo's data.",
  ].join("\n");
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
  const refusals: Refusal[] = [];
  const review: Card[] = [];
  const otherNames = new Set<string>();
  let submitted: { entity_id: string; line: string }[] = [];
  let submitCalls = 0;

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

  const record = (slot: SlotSpec, toolName: ToolName, params: Record<string, unknown>, r: ToolResult & { cell?: string }, routedBy: RoutedBy, ms: number) => {
    refusals.push(...r.refusals);
    review.push(...r.review);
    for (const x of r.refusals) otherNames.add(x.name);
    for (const x of r.review) otherNames.add(x.name);
    const s: AgentSlot = { slot, card: r.card, routedBy, tool: toolName, params, ...(r.card ? {} : { empty: r.empty ?? "no verified candidate" }), ...(r.cell ? { cell: r.cell } : {}) };
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
  const runSlot = async (slot: SlotSpec, toolName: ToolName, params: Record<string, unknown>, routedBy: RoutedBy) => {
    const t = Date.now();
    let r: ToolResult & { cell?: string };
    if (toolName === "findAtHome") r = await findAtHome(ctx, slot, slot.homeType!, (params.take as number | undefined) ?? 5);
    else if (toolName === "findOutings") r = await findOutings(ctx, slot, { narrowMeters: params.narrowMeters as number | undefined });
    else r = await placeSocial(ctx, slot);
    pending.delete(slot.day);
    return record(slot, toolName, params, r, routedBy, Date.now() - t);
  };

  /** a slot left empty only because Qloo was unavailable may be routed again */
  const retryable = (day: DayName) => {
    const f = filled.get(day);
    return !pending.has(day) && !!f && !f.card && (f.empty ?? "").startsWith("Qloo unavailable");
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
    return slot!;
  };

  const summary = (s: AgentSlot) =>
    s.card
      ? { ok: true, day: s.slot.day, entity_id: s.card.entity_id, name: s.card.name, type: s.card.entityType, hour: fmtHour(s.card.hour), ...(s.card.movedFrom !== undefined ? { movedFrom: fmtHour(s.card.movedFrom) } : {}), ...(s.card.distance_m !== undefined ? { distance_m: s.card.distance_m } : {}), because: whyText(s.card) }
      : { ok: false, day: s.slot.day, empty: s.empty };

  const tools = {
    findAtHome: tool({
      description: "Fill a home slot with a 10-minute at-home dose: Qloo picks one entity of the chosen domain from the patient's taste signals.",
      inputSchema: z.object({ day: dayEnum, type: z.enum(HOME_TYPES as unknown as [HomeType, ...HomeType[]]), take: z.number().int().min(3).max(10).optional() }),
      execute: async ({ day, type, take }) => {
        const slot = claim("findAtHome", day, "home");
        if ("error" in slot) return { ok: false, error: slot.error };
        return summary(await runSlot({ ...slot, homeType: type }, "findAtHome", { day, type, ...(take ? { take } : {}) }, "llm"));
      },
    }),
    findOutings: tool({
      description: "Fill a solo slot with a verified place: open at the hour and checked by the server against the case row (the model cannot see or change those checks).",
      inputSchema: z.object({ day: dayEnum, hour: z.number().int().min(8).max(21).optional(), narrowMeters: z.number().int().min(300).max(5000).optional() }),
      execute: async ({ day, hour, narrowMeters }) => {
        const slot = claim("findOutings", day, "solo");
        if ("error" in slot) return { ok: false, error: slot.error };
        return summary(await runSlot({ ...slot, hour: hour ?? slot.hour }, "findOutings", { day, ...(hour ? { hour } : {}), ...(narrowMeters ? { narrowMeters } : {}) }, "llm"));
      },
    }),
    placeSocial: tool({
      description: "Fill the social slot: Qloo's heatmap finds where people with the same taste gather near the patient, then a verified place there.",
      inputSchema: z.object({ day: dayEnum, hour: z.number().int().min(8).max(21).optional() }),
      execute: async ({ day, hour }) => {
        const slot = claim("placeSocial", day, "social");
        if ("error" in slot) return { ok: false, error: slot.error };
        return summary(await runSlot({ ...slot, hour: hour ?? slot.hour }, "placeSocial", { day, ...(hour ? { hour } : {}) }, "llm"));
      },
    }),
    submitPlan: tool({
      description: "Finish: one coaching line (≤25 words) per placed card, keyed by the entity_id a tool returned.",
      inputSchema: z.object({ coaching: z.array(z.object({ entity_id: z.string(), line: z.string() })).max(14) }),
      execute: async ({ coaching }) => {
        submitted = [...submitted, ...coaching];
        submitCalls++;
        return { ok: true };
      },
    }),
  } satisfies ToolSet;

  const submittedStop: StopCondition<typeof tools> = ({ steps }) => steps.some((s) => s.toolCalls.some((tc) => tc.toolName === "submitPlan"));

  let routedBy: { provider: string; model: string } | null = null;
  let llmSteps = 0;
  let llmMs = 0;
  const llmErrors: { provider: string; error: string }[] = [];
  // 20 s for the model leaves room for the deterministic fallback inside the 30 s plan gate (Groq TPM limits seen live)
  const deadline = t0 + (opts.llmBudgetMs ?? 20_000);

  // Walk the provider chain. A provider that makes progress but stops early (e.g. one tool per step until the step cap)
  // gets another round for what is still open — the slots, then the coaching hand-off; a provider that errors or calls
  // no tool hands over to the next one.
  let i = 0;
  let rounds = 0;
  while (i < opts.llms.length && rounds < opts.llms.length + 2) {
    rounds++;
    const llm = opts.llms[i];
    const open = skeleton.filter((s) => !claimed.has(s.day) || retryable(s.day));
    if (!open.length && (submitCalls > 0 || filled.size === 0)) break;
    const remaining = deadline - Date.now();
    if (remaining < 2000) break;
    try {
      const before = { claimed: claimed.size, submits: submitCalls };
      await generateText({
        model: llm.model,
        system: systemPrompt(),
        prompt: open.length ? userPrompt(c, week, history, open) + (filled.size ? `\nAlready placed (keep; coach these too):\n${[...filled.values()].filter((f) => f.card).map((f) => JSON.stringify(summary(f))).join("\n")}` : "") : `All slots are filled:\n${[...filled.values()].map((s) => JSON.stringify(summary(s))).join("\n")}\nCall submitPlan now.`,
        tools,
        stopWhen: [stepCountIs(opts.maxSteps ?? 10), submittedStop],
        maxRetries: 1,
        temperature: 0.2,
        abortSignal: AbortSignal.timeout(remaining),
        // once every slot is routed, the only remaining move is the coaching hand-off
        prepareStep: () => (allRouted() ? { activeTools: ["submitPlan"], toolChoice: { type: "tool", toolName: "submitPlan" } } : {}),
        onLanguageModelCallEnd: (e) => {
          const ms = Math.round(e.performance.responseTimeMs);
          llmSteps++;
          llmMs += ms;
          const toolCalls = e.content.flatMap((part) => (part.type === "tool-call" ? [part.toolName] : []));
          emit({ type: "llm", provider: llm.provider, model: llm.modelId, step: llmSteps, ms, toolCalls, finishReason: String(e.finishReason), outputTokens: e.usage.outputTokens ?? null });
        },
      });
      if (!routedBy && claimed.size > 0) routedBy = { provider: llm.provider, model: llm.modelId };
      if (allRouted() && submitCalls > 0) break;
      if (claimed.size === before.claimed && submitCalls === before.submits) throw new Error("the model made no progress (no tool called)");
    } catch (e) {
      const error = (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).slice(0, 300);
      llmErrors.push({ provider: llm.provider, error });
      const next = opts.llms[i + 1];
      emit({ type: "llm_fallback", from: `${llm.provider}:${llm.modelId}`, to: next ? `${next.provider}:${next.modelId}` : null, error });
      if (!routedBy && claimed.size > 0) routedBy = { provider: llm.provider, model: llm.modelId };
      i++;
    }
  }

  // Deterministic fallback for any slot the LLM never routed: same tools, same verifier, never the model's own text.
  for (const slot of skeleton) {
    if (claimed.has(slot.day)) continue;
    claimed.add(slot.day);
    const toolName: ToolName = slot.rung === "home" ? "findAtHome" : slot.rung === "solo" ? "findOutings" : "placeSocial";
    await runSlot(slot, toolName, { day: slot.day, ...(slot.homeType ? { type: slot.homeType } : {}) }, "fallback");
  }

  const slots = skeleton.map((s) => filled.get(s.day)!).filter(Boolean);
  for (const s of slots) if (s.card) otherNames.add(s.card.name);
  const dropped = assembleCoaching(slots, submitted, otherNames);
  if (dropped.length) emit({ type: "truth_boundary", dropped });

  const plan: AgentPlan = { week, slots, refusals, review, calls: [], llm: routedBy, llmSteps, llmMs, llmErrors, dropped, latencyMs: Date.now() - t0 };
  emit({ type: "plan", plan });
  return plan;
}

/** I1 check used by tests and scripts: every card carries a Qloo entity_id returned in this run. */
export function cardsWithoutEntity(plan: AgentPlan): number {
  return plan.slots.filter((s) => s.card && !s.card.entity_id).length;
}
