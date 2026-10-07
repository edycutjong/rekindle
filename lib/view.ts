/**
 * Pure view helpers for the week ledger (specs/ui.md). Every string a card shows is derived here from the stored plan
 * (Qloo data + verifier results), so the UI never states a fact the plan does not carry. Unit-tested in tests/view.test.ts.
 */
import type { CardDoc, CaseDoc, PlanDoc, RefusalDoc } from "./store";
import { DAYS, type DayName } from "./verify";

export const DAY_SHORT: Record<DayName, string> = { monday: "Mon", tuesday: "Tue", wednesday: "Wed", thursday: "Thu", friday: "Fri", saturday: "Sat", sunday: "Sun" };

export const fmtHour = (h: number) => `${String(h).padStart(2, "0")}:00`;

export const priceLabel = (n: number) => `≤${"$".repeat(Math.max(1, Math.min(4, n)))}`;

export function distanceLabel(m: number): string {
  return m >= 1000 ? `≤${(m / 1000).toFixed(m % 1000 === 0 ? 0 : 1)} km` : `≤${m} m`;
}

export const ENTITY_TYPE: Record<string, string> = {
  "urn:entity:artist": "artist",
  "urn:entity:podcast": "podcast",
  "urn:entity:book": "book",
  "urn:entity:tv_show": "TV show",
  "urn:entity:movie": "film",
  "urn:entity:place": "place",
};
export const typeLabel = (t: string | undefined) => (t ? (ENTITY_TYPE[t] ?? t.replace(/^urn:(entity|tag):/, "").replace(/_/g, " ")) : "tag");

/** "home · 10 min · 19:00", "solo · 15:00", "social · 14:00" */
export function rungLabel(c: Pick<CardDoc, "rung" | "hour">): string {
  return c.rung === "home" ? `home · 10 min · ${fmtHour(c.hour)}` : `${c.rung} · ${fmtHour(c.hour)}`;
}

/** Why line: the per-love explainability split (never the bare affinity), highest first, at most three loves. */
export function whyParts(explain: CardDoc["explain_json"]): { name: string; weight: string }[] {
  return [...explain]
    .filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((e) => ({ name: e.name || e.entity_id, weight: e.score.toFixed(2) }));
}

const check = (c: CardDoc, rule: string) => c.checks.find((x) => x.rule === rule);

/** Hours check for an outing: `1161 m · Thu 12:00–18:00 · slot 15:00 ✓` (+ the re-slot, when there was one). */
export function hoursCheck(c: CardDoc): { distance: string | null; hours: string | null; slot: string; ok: boolean; moved: string | null } | null {
  if (c.rung === "home") return null;
  const open = check(c, "R-OPEN");
  return {
    distance: c.distance_m !== undefined ? `${c.distance_m} m` : null,
    hours: c.hours_text ?? null,
    slot: `slot ${fmtHour(c.hour)}`,
    ok: open?.verdict === "PASS",
    moved: c.moved_from !== undefined && c.moved_from !== c.hour ? `moved from ${fmtHour(c.moved_from)} (closed then)` : null,
  };
}

/** The rules a placed outing passed, short and in data face: R-OPEN ✓ R-NEAR ✓ … (title carries the detail). */
export function passedChecks(c: CardDoc): { rule: string; detail: string }[] {
  if (c.rung === "home") return c.checks.filter((x) => x.rule === "R-ID" && x.verdict === "PASS").map((x) => ({ rule: x.rule, detail: "a Qloo entity returned in this run" }));
  return c.checks.filter((x) => x.verdict === "PASS").map((x) => ({ rule: x.rule, detail: x.detail }));
}

/** One line per refused candidate, deduplicated per day (the social fallback ladder can see a venue twice). */
export interface Strike {
  key: string;
  name: string;
  rule: string;
  detail: string;
  verdict: RefusalDoc["verdict"];
  hour: number;
  movedTo: number | null;
  byToggle: boolean;
  /** other rules that refused the same venue in the same day (one strike per venue, not one per rule) */
  also: string[];
}

export function strikesByDay(plan: Pick<PlanDoc, "refusals" | "cards">): Record<DayName, Strike[]> {
  const out = Object.fromEntries(DAYS.map((d) => [d, [] as Strike[]])) as Record<DayName, Strike[]>;
  // refusals struck by a constraint toggle first: they are the ones that just changed on the sheet
  const ordered = [...plan.refusals].sort((a, b) => Number(!!b.struck_by_toggle) - Number(!!a.struck_by_toggle));
  for (const r of ordered) {
    const key = `${r.day_name}|${r.qloo_entity_id}`;
    const prev = out[r.day_name].find((x) => x.key === key);
    if (prev) {
      if (r.rule !== prev.rule && !prev.also.includes(r.rule)) prev.also.push(r.rule);
      continue;
    }
    out[r.day_name].push({ key, name: r.name, rule: r.rule, detail: r.detail, verdict: r.verdict, hour: r.hour, movedTo: r.moved_to ?? null, byToggle: !!r.struck_by_toggle, also: [] });
  }
  return out;
}

/**
 * REVIEW boxes per day, deduplicated across the week by entity_id (the same venue can be screened on two days, and the
 * social fallback ladder can see it twice) and never one that is already placed as a card. First day wins.
 */
export function reviewsByDay(plan: Pick<PlanDoc, "review" | "cards">): Record<DayName, CardDoc[]> {
  const out = Object.fromEntries(DAYS.map((d) => [d, [] as CardDoc[]])) as Record<DayName, CardDoc[]>;
  const placed = new Set(plan.cards.map((c) => c.qloo_entity_id));
  const seen = new Set<string>();
  for (const r of [...plan.review].sort((a, b) => a.day - b.day)) {
    if (placed.has(r.qloo_entity_id) || seen.has(r.qloo_entity_id)) continue;
    seen.add(r.qloo_entity_id);
    out[r.day_name].push(r);
  }
  return out;
}

/** Long rule details (R-ALC can list a dozen tags) are cut to the first two items; the full text goes in a title. */
export function shortDetail(detail: string, max = 2): string {
  const items = detail.split(", ");
  if (items.length <= max) return detail;
  return `${items.slice(0, max).join(", ")} +${items.length - max} more`;
}

/** The reason line under a strike, e.g. `R-ALC · cocktail_bar · struck when a constraint changed`. */
export function strikeReason(s: Strike): string {
  const parts = [s.rule, shortDetail(s.detail)];
  if (s.also.length) parts.push(`also ${s.also.join(", ")}`);
  if (s.movedTo !== null) parts.push(`→ moved to ${fmtHour(s.movedTo)}`);
  if (s.byToggle) parts.push("struck when a constraint changed");
  return parts.join(" · ");
}

export interface Loved {
  kind: string;
  name: string;
}
export const lovedTokens = (c: Pick<CaseDoc, "loves">): Loved[] => c.loves.map((l) => ({ kind: l.qloo_kind === "tag" ? "tag" : typeLabel(l.entity_type), name: l.name || l.text }));

/** Trace lines rebuilt from a stored plan (reload): one per routed slot + refusals by rule. */
export function traceFromPlan(plan: PlanDoc): string[] {
  const lines: string[] = [];
  if (plan.origin === "toggle" && plan.toggle) {
    lines.push(`constraint change ${Object.entries(plan.toggle.changed).map(([k, v]) => `${k}=${v}`).join(", ")} → struck ${plan.toggle.struck} · refilled ${plan.toggle.refilled} · ${(plan.toggle.ms / 1000).toFixed(1)} s`);
  }
  const strikes = strikesByDay(plan);
  const slots = [...plan.cards.map((c) => ({ day: c.day_name, card: c as CardDoc | null, empty: null as string | null })), ...plan.empty_slots.map((e) => ({ day: e.day_name, card: null, empty: e.reason }))].sort((a, b) => DAYS.indexOf(a.day) - DAYS.indexOf(b.day));
  for (const s of slots) {
    const tool = s.card?.tool ?? "slot";
    const params = s.card ? Object.entries(s.card.tool_params).map(([k, v]) => `${k}=${String(v)}`).join(" ") : "";
    const byRule = countBy(strikes[s.day].map((x) => x.rule));
    const refused = Object.keys(byRule).length ? ` · refused ${Object.entries(byRule).map(([r, n]) => `${r} ${n}`).join(", ")}` : "";
    const route = s.card ? ` (${s.card.routed_by})` : "";
    lines.push(`${tool} ${params}${route} → ${s.card ? s.card.name : `empty: ${s.empty}`}${refused}`.replace(/\s+/g, " "));
  }
  return lines;
}

export function countBy(xs: string[]): Record<string, number> {
  const o: Record<string, number> = {};
  for (const x of xs) o[x] = (o[x] ?? 0) + 1;
  return o;
}

/** Live trace line for one SSE event (null = not shown as its own line). */
export function traceLine(e: { type: string } & Record<string, unknown>): string | null {
  switch (e.type) {
    case "start":
      return `start week ${e.week} · ${(e.slots as unknown[]).length} slots · LLM ${(e.llm as string[]).join(" → ") || "none (deterministic)"}`;
    case "llm":
      return `${e.provider}:${e.model} step ${e.step} · ${(e.toolCalls as string[]).length} tool call${(e.toolCalls as string[]).length === 1 ? "" : "s"} · ${e.ms} ms`;
    case "llm_fallback":
      return `LLM fallback ${e.from} → ${e.to ?? "deterministic route"}`;
    case "tool": {
      const p = Object.entries((e.params as Record<string, unknown>) ?? {}).map(([k, v]) => `${k}=${String(v)}`).join(" ");
      const rf = Object.entries((e.refusals as Record<string, number>) ?? {}).map(([r, n]) => `${r} ${n}`).join(", ");
      const card = e.card as { name: string } | null;
      return `${e.tool} ${p} → ${e.returned} returned${rf ? ` · refused ${rf}` : ""}${e.review ? ` · review ${e.review}` : ""} → ${card ? `${card.name} ✓` : `empty: ${e.empty ?? "no verified candidate"}`}`.replace(/\s+/g, " ");
    }
    case "tool_rejected":
      return `rejected ${e.tool} ${e.day}: ${e.reason}`;
    case "truth_boundary":
      return `truth boundary dropped ${(e.dropped as unknown[]).length} line(s)`;
    default:
      return null;
  }
}

export const CONSTRAINT_FLAGS = [
  { key: "in_recovery", label: "In recovery" },
  { key: "need_quiet", label: "Quiet" },
  { key: "need_wheelchair", label: "Wheelchair entrance" },
] as const;

export const DISTANCE_OPTIONS = [800, 1500, 3000, 5000] as const;
export const PRICE_OPTIONS = [1, 2, 3, 4] as const;

/* ------------------------------------------------------------ clinician gate + re-plan (D7) */

/** "approved · Wed 7 Oct · 14:02 UTC" — the stamp on the sheet header */
export function stampLabel(iso: string): string {
  const d = new Date(iso);
  const day = d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).replace(",", "");
  return `approved · ${day} · ${d.toISOString().slice(11, 16)} UTC`;
}

export interface PendingRating {
  pleasure: number | null;
  mastery: number | null;
}

/** Activities that will count as rated once pending edits are saved (the re-plan button needs ≥ 3). */
export function ratedCount(cards: readonly Pick<CardDoc, "id" | "pleasure">[], pending: Readonly<Record<string, PendingRating>>): number {
  return cards.filter((c) => (pending[c.id]?.pleasure ?? c.pleasure) !== null).length;
}

/** Pending edits that differ from what is stored and carry a pleasure score (what "save" sends). */
export function changedRatings(cards: readonly Pick<CardDoc, "id" | "pleasure" | "mastery">[], pending: Readonly<Record<string, PendingRating>>): { card_id: string; pleasure: number; mastery: number | null }[] {
  return cards.flatMap((c) => {
    const p = pending[c.id];
    if (!p || p.pleasure === null) return [];
    if (p.pleasure === c.pleasure && p.mastery === c.mastery) return [];
    return [{ card_id: c.id, pleasure: p.pleasure, mastery: p.mastery }];
  });
}

export const clampScore = (n: number) => Math.max(0, Math.min(10, Math.round(n)));

export interface EmberLink {
  from: string;
  from_id: string;
  to: string;
  to_id: string;
  score: number;
  /** the pleasure the patient gave the week-1 activity */
  rated: number | null;
}

/**
 * The ember threads to draw: only links where the rekindled entity is the week-2 card's TOP-weighted input (Qloo spreads
 * explainability across every signal entity, so "names it at all" would thread nearly every card). One per week-2 card.
 */
export function emberThreads(diff: NonNullable<PlanDoc["diff"]> | null, prevCards: readonly Pick<CardDoc, "qloo_entity_id" | "pleasure">[] = []): EmberLink[] {
  if (!diff) return [];
  const rated = new Map(prevCards.map((c) => [c.qloo_entity_id, c.pleasure]));
  const seen = new Set<string>();
  const out: EmberLink[] = [];
  for (const e of diff.ember) {
    if (!e.top || seen.has(e.to_id)) continue;
    seen.add(e.to_id);
    out.push({ from: e.from, from_id: e.from_id, to: e.to, to_id: e.to_id, score: e.score, rated: rated.get(e.from_id) ?? null });
  }
  return out;
}

/** Inline ember label (and the mobile form of the thread): "← because she rated Dun-Well Doughnuts 8 · 0.41" */
export const emberLabel = (l: EmberLink) => `← because of ${l.from}${l.rated !== null ? `, rated ${l.rated}` : ""} · ${l.score.toFixed(2)}`;

/** Ember mark on the activity a re-plan kept: "↻ kept: rated 9 last week · re-checked live" */
export function keptLabel(c: Pick<CardDoc, "routed_by" | "tool_params">): string | null {
  if (c.routed_by !== "kept") return null;
  const rated = typeof c.tool_params.rated === "number" ? `, rated ${c.tool_params.rated}` : "";
  return `↻ kept from last week${rated} · re-checked live`;
}

/**
 * The notice after a constraint toggle. Loosening (wider radius, higher budget, a flag off) retries the empty outing
 * slots live, so the notice reports that retry — "Retried 2 empty outings within 3 km: 1 filled" — instead of implying
 * nothing happened (QA round 1). Tightening reports what was struck and refilled.
 */
export function toggleNotice(before: Pick<PlanDoc, "id" | "cards" | "empty_slots">, beforeCase: Pick<CaseDoc, "max_meters" | "price_max" | "in_recovery" | "need_quiet" | "need_wheelchair">, after: Pick<PlanDoc, "id" | "cards" | "toggle">, afterCase: Pick<CaseDoc, "max_meters" | "price_max" | "in_recovery" | "need_quiet" | "need_wheelchair">): string {
  const t = after.toggle;
  if (after.id === before.id || !t) return "No change to the week.";
  const secs = `${(t.ms / 1000).toFixed(1)} s`;
  const loosened = afterCase.max_meters > beforeCase.max_meters || afterCase.price_max > beforeCase.price_max || (beforeCase.in_recovery && !afterCase.in_recovery) || (beforeCase.need_quiet && !afterCase.need_quiet) || (beforeCase.need_wheelchair && !afterCase.need_wheelchair);
  if (loosened) {
    const emptyDays = new Set(before.empty_slots.filter((e) => e.rung !== "home").map((e) => e.day_name));
    const filled = after.cards.filter((c) => emptyDays.has(c.day_name)).length;
    const where = afterCase.max_meters > beforeCase.max_meters ? ` within ${distanceLabel(afterCase.max_meters).slice(1)}` : " under the new setting";
    if (emptyDays.size === 0) return `Every placed outing still passes, and no outing was empty to retry (${secs}).`;
    return `Retried ${emptyDays.size} empty outing${emptyDays.size === 1 ? "" : "s"}${where}: ${filled} filled, ${emptyDays.size - filled} still empty · ${secs}. The verified cards stay as they were.`;
  }
  if (t.struck === 0 && t.refilled === 0) return `Every placed outing still passes the new constraint (${secs}).`;
  if (t.struck === 0) return `${t.refilled} outing${t.refilled === 1 ? "" : "s"} moved to clinician review and refilled live · ${secs}`;
  return `${t.struck} outing${t.struck === 1 ? "" : "s"} struck in place and ${t.refilled} slot${t.refilled === 1 ? "" : "s"} refilled live · ${secs}`;
}

/** The notice after a swap: what left the slot and what (if anything) replaced it. */
export function swapNotice(before: Pick<CardDoc, "name" | "day_name">, plan: Pick<PlanDoc, "cards">, swap: { found: boolean; ms: number; calls: number }): string {
  const now = plan.cards.find((c) => c.day_name === before.day_name);
  const t = `${swap.calls} Qloo call${swap.calls === 1 ? "" : "s"} · ${(swap.ms / 1000).toFixed(1)} s`;
  return swap.found && now ? `Swapped ${before.name} for ${now.name}, verified the same way (${t}).` : `No other verified candidate for ${DAY_SHORT[before.day_name]}; the slot is left empty (${t}).`;
}

/* ------------------------------------------------------------------ edge states (D10) */

export const isOutage = (reason: string | null | undefined) => !!reason && reason.startsWith("Qloo unavailable");

/** The radius the coverage refusal offers next (the case-strip distance steps), or null at the widest. */
export function widerRadius(current: number, steps: readonly number[] = DISTANCE_OPTIONS): number | null {
  return steps.find((m) => m > current) ?? null;
}

export interface CoverageRefusal {
  /** "Only 1 of 3 outings could be verified within 1.5 km (quiet), open at the slot." */
  headline: string;
  slots: { day: DayName; line: string }[];
  /** the radius the clinician may consent to, or null when already at the widest step */
  widen: number | null;
}

/**
 * Coverage refusal (architecture.md failure state 2): outing slots left empty because no candidate within the case's
 * radius passed the verifier — never filled with an unverified suggestion. Outage-empty slots are not coverage.
 */
export function coverageRefusal(plan: Pick<PlanDoc, "cards" | "empty_slots">, c: Pick<CaseDoc, "max_meters" | "need_quiet" | "need_wheelchair" | "in_recovery" | "price_max">): CoverageRefusal | null {
  const empties = plan.empty_slots.filter((e) => e.rung !== "home" && !isOutage(e.reason));
  if (empties.length === 0) return null;
  const outings = plan.cards.filter((x) => x.rung !== "home").length + plan.empty_slots.filter((e) => e.rung !== "home").length;
  const verified = plan.cards.filter((x) => x.rung !== "home").length;
  const flags = [c.need_quiet && "quiet", c.need_wheelchair && "wheelchair entrance", c.in_recovery && "alcohol-free", priceLabel(c.price_max)].filter(Boolean).join(", ");
  return {
    headline: `Only ${verified} of ${outings} outing${outings === 1 ? "" : "s"} could be verified within ${distanceLabel(c.max_meters).slice(1)} (${flags}), open at the slot.`,
    slots: empties.map((e) => ({ day: e.day_name, line: `${DAY_SHORT[e.day_name]} ${fmtHour(e.hour)} ${e.rung}: ${e.reason}` })),
    widen: widerRadius(c.max_meters),
  };
}

/** Qloo-unavailable state: how many slots an outage left empty, and whether it was the labelled demo. */
export function outageState(plan: Pick<PlanDoc, "empty_slots" | "fault">): { slots: number; injected: boolean } | null {
  const n = plan.empty_slots.filter((e) => isOutage(e.reason)).length;
  return n ? { slots: n, injected: plan.fault === "qloo_unreachable" } : null;
}

/* ------------------------------------------------------------------ patient print view (ui.md 7) */

export interface PrintRow {
  day: string;
  time: string;
  activity: string;
  kind: string;
  /** the address for outings; "at home" for home doses */
  where: string;
  /** the clinician-approved coaching line (the dose) */
  how: string;
}

/**
 * The patient-facing sheet: approved cards only, in day order, with what / when / where / how and nothing else —
 * no strikes, no trace, no explainability weights, no rule IDs (ui.md 7). A week that is still a draft prints nothing:
 * nothing reaches the patient without the clinician's approval (spec, decision condition 1).
 */
export function printSheet(plan: Pick<PlanDoc, "status" | "cards">): { printable: boolean; rows: PrintRow[] } {
  if (plan.status === "draft") return { printable: false, rows: [] };
  const rows = plan.cards
    .filter((c) => c.clinician_action === "approved")
    .sort((a, b) => a.day - b.day || a.hour - b.hour)
    .map((c) => ({
      day: c.day_name.charAt(0).toUpperCase() + c.day_name.slice(1),
      time: c.rung === "home" ? `${fmtHour(c.hour)} · about 10 minutes` : fmtHour(c.hour),
      activity: c.name,
      kind: c.rung === "home" ? typeLabel(c.home_type ? `urn:entity:${c.home_type}` : c.entity_type) : c.rung === "social" ? "outing with people around" : "outing on your own",
      where: c.rung === "home" ? "at home" : (c.address ?? "address on the clinician's sheet"),
      how: c.coaching,
    }));
  return { printable: true, rows };
}
