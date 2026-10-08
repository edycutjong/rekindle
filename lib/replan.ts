/**
 * Re-plan math (deterministic). Ratings → next week's Qloo signals and exclusions, and the diff the clinician sees.
 *
 *   pleasure ≥ 7 → the entity joins signal.interests.entities; for a place, its top-2 specific genre tags join
 *                  signal.interests.tags
 *   pleasure ≤ 3 → the entity goes to filter.exclude.entities (and R-HIST); its distinctive genre tags (not shared
 *                  with any ≥ 7 card) go to filter.exclude.tags
 *   clinician strike (swapped out / removed at the gate) → filter.exclude.entities (and R-HIST) in every later week
 *   mastery is recorded and shown; it does not change Qloo signals.
 */
import type { Card, PlanHistory, WeekPlan } from "./plan";
import type { DayName } from "./verify";

export interface Rating {
  entity_id: string;
  pleasure: number;
  mastery: number;
}

/** Specific genre tags of a place, most specific first (skips the generic `genre:place:restaurant`). */
export function specificGenreTags(tags: readonly string[]): string[] {
  return tags.filter((t) => t.startsWith("urn:tag:genre:place:") && t !== "urn:tag:genre:place:restaurant").sort((a, b) => b.split(":").length - a.split(":").length);
}

export function historyFromRatings(prevHistory: PlanHistory, cards: readonly Card[], ratings: readonly Rating[], struck: readonly string[] = []): PlanHistory {
  const byId = new Map(cards.map((c) => [c.entity_id, c]));
  const high = ratings.filter((r) => r.pleasure >= 7).map((r) => byId.get(r.entity_id)).filter((c): c is Card => !!c);
  const low = ratings.filter((r) => r.pleasure <= 3).map((r) => byId.get(r.entity_id)).filter((c): c is Card => !!c);
  const highTags = new Set(high.flatMap((c) => c.tags));
  const signalTags = high.filter((c) => c.rung !== "home").flatMap((c) => specificGenreTags(c.tags).slice(0, 2));
  const excludeTags = low.filter((c) => c.rung !== "home").flatMap((c) => specificGenreTags(c.tags).filter((t) => !highTags.has(t)).slice(0, 2));
  return {
    rekindled: dedupe([...prevHistory.rekindled, ...high.map((c) => ({ entity_id: c.entity_id, name: c.name, tags: c.tags, entityType: c.entityType }))], (x) => x.entity_id),
    lowRated: [...new Set([...prevHistory.lowRated, ...low.map((c) => c.entity_id)])],
    excludeTags: [...new Set([...prevHistory.excludeTags, ...excludeTags])],
    signalTags: [...new Set([...prevHistory.signalTags, ...signalTags])].filter((t) => !excludeTags.includes(t)),
    // the clinician's own refusals (swap / remove) are remembered: never brought back by a later week
    struck: [...new Set([...(prevHistory.struck ?? []), ...struck])].filter((id) => !high.some((c) => c.entity_id === id)),
  };
}

export interface ReplanDiff {
  /** `reason` is set on the activity kept because it was rated ≥ 7 (re-checked live) */
  kept: { day: DayName; name: string; reason?: string }[];
  added: { day: DayName; name: string; because: { name: string; score: number }[] }[];
  removed: { day: DayName; name: string; reason: string }[];
  /** rated ≥ 7 in the previous week but not on this one: they are this week's Qloo signals (not "leaving out") */
  signals: { day: DayName; name: string; reason: string }[];
  /**
   * Week-2 cards whose explainability names a rekindled (≥ 7) entity. Qloo spreads explainability across every signal
   * entity, so almost every week-2 card names every rekindled entity; `top` marks the stronger claim (T16, a2a r04):
   * the entity is the card's highest-weighted RATED input and leads the card's best ORIGINAL-LOVE input (the case's
   * loves, i.e. every input that is not a rating) by at least EMBER_MIN_MARGIN — the same margin bench/replan.json
   * reports. `margin` = its weight minus that best original-love weight. The other rated inputs on the card are its
   * co-inputs (shown on the label, never threaded). The UI draws an ember thread only for `top` links; a rated input
   * that leads the loves by less is shown as a tie, never as "because of" (QA round 3). It is Qloo's attribution, not
   * causation. Before T16 the margin was the lead over the card's next input of any kind, so two ratings cancelled
   * each other's threads (2 of 77 live cards threaded).
   */
  ember: { from: string; from_id: string; to: string; to_id: string; day: DayName; score: number; top: boolean; margin: number }[];
}

/**
 * Minimum lead of the top rated input's explainability weight over the card's best original-love input before the UI
 * says "because of" it. Qloo splits explainability roughly evenly across signals (≈ 1/3 each with three loves), so
 * smaller leads are ties; 0.02 is the bench's PASS definition for "the rated input leads".
 */
export const EMBER_MIN_MARGIN = 0.02;

export interface ExplainInput {
  entity_id: string;
  name?: string;
  score: number;
}

/**
 * The ember rule on one card's explainability (T16). `rated` = the rekindled (≥ 7) entity IDs; every other input is an
 * original love. `top` = the highest-weighted rated input (score > 0), `love` = the best original-love input,
 * `margin` = top − love (love absent → 0), `co` = the other rated inputs that also outweigh that love, strongest first.
 * `threads` = margin ≥ EMBER_MIN_MARGIN. Returns null when no rated input carries weight on the card.
 */
export function emberLead<T extends ExplainInput>(why: readonly T[], rated: ReadonlySet<string>): { top: T; love: T | null; margin: number; co: T[]; threads: boolean } | null {
  const rek = why.filter((w) => rated.has(w.entity_id) && w.score > 0).sort((a, b) => b.score - a.score);
  const top = rek[0];
  if (!top) return null;
  const love = [...why].filter((w) => !rated.has(w.entity_id)).sort((a, b) => b.score - a.score)[0] ?? null;
  const floor = Math.max(0, love?.score ?? 0);
  const margin = Math.round((top.score - floor) * 1e6) / 1e6;
  return { top, love, margin, co: rek.slice(1).filter((w) => w.score > floor), threads: margin >= EMBER_MIN_MARGIN };
}

/** Weight of `id` minus the strongest other input in the same explainability list (negative: another input leads). The pre-T16 ember margin; scripts/ember-margins.ts still reports it for comparison. */
export function explainMargin(why: readonly { entity_id: string; score: number }[], id: string): number {
  const own = why.find((w) => w.entity_id === id)?.score ?? 0;
  const other = Math.max(0, ...why.filter((w) => w.entity_id !== id).map((w) => w.score));
  return Math.round((own - other) * 1e6) / 1e6;
}

/** The live re-check of the top-rated activity on a re-plan (lib/plan.ts recheckKept), stored with the diff. */
export interface KeptNote {
  entity_id: string;
  name: string;
  ok: boolean;
  detail: string;
}

export function diffWeeks(w1: WeekPlan, w2: WeekPlan, h: PlanHistory, keptNote: KeptNote | null = null): ReplanDiff {
  const ids1 = new Set(w1.slots.flatMap((s) => (s.card ? [s.card.entity_id] : [])));
  const ids2 = new Set(w2.slots.flatMap((s) => (s.card ? [s.card.entity_id] : [])));
  const rek = new Map(h.rekindled.map((r) => [r.entity_id, r.name]));
  const rated = new Set(rek.keys());
  const out: ReplanDiff = { kept: [], added: [], removed: [], signals: [], ember: [] };
  for (const s of w2.slots) {
    if (!s.card) continue;
    if (ids1.has(s.card.entity_id)) out.kept.push({ day: s.slot.day, name: s.card.name, ...(rek.has(s.card.entity_id) ? { reason: keptNote?.entity_id === s.card.entity_id && keptNote.ok ? `rated ≥7 — ${keptNote.detail}` : "rated ≥7 — kept" } : {}) });
    else out.added.push({ day: s.slot.day, name: s.card.name, because: s.card.why.map((w) => ({ name: w.name, score: w.score })) });
    const lead = emberLead(s.card.why, rated);
    const floor = Math.max(0, lead?.love?.score ?? 0);
    for (const w of s.card.why) {
      if (!rek.has(w.entity_id) || w.score <= 0) continue;
      const margin = Math.round((w.score - floor) * 1e6) / 1e6;
      out.ember.push({ from: rek.get(w.entity_id)!, from_id: w.entity_id, to: s.card.name, to_id: s.card.entity_id, day: s.slot.day, score: w.score, top: !!lead?.threads && lead.top.entity_id === w.entity_id, margin });
    }
  }
  for (const s of w1.slots) {
    if (!s.card || ids2.has(s.card.entity_id)) continue;
    if (rek.has(s.card.entity_id)) {
      const why = keptNote && keptNote.entity_id === s.card.entity_id && !keptNote.ok ? `not kept: ${keptNote.detail}; ` : "";
      out.signals.push({ day: s.slot.day, name: s.card.name, reason: `rated ≥7 — ${why}now a Qloo signal for this week` });
      continue;
    }
    out.removed.push({ day: s.slot.day, name: s.card.name, reason: h.lowRated.includes(s.card.entity_id) ? "rated ≤3 — excluded" : "replaced by a re-planned pick" });
  }
  return out;
}

/** Seed rating rule: top at-home card P7, top outing P8, lowest outing P2. Needs ≥ 2 verified outings. */
export function seedRatings(w: WeekPlan): Rating[] | null {
  const cards = w.slots.flatMap((s) => (s.card ? [s.card] : []));
  const home = cards.filter((c) => c.rung === "home").sort((a, b) => b.affinity - a.affinity);
  const outs = cards.filter((c) => c.rung !== "home").sort((a, b) => b.affinity - a.affinity);
  if (outs.length < 2 || home.length < 1) return null;
  return [
    { entity_id: home[0].entity_id, pleasure: 7, mastery: 5 },
    { entity_id: outs[0].entity_id, pleasure: 8, mastery: 6 },
    { entity_id: outs[outs.length - 1].entity_id, pleasure: 2, mastery: 3 },
  ];
}

/**
 * Which activity a re-plan tries to keep: the highest pleasure ≥ 7 (ties: an outing before an at-home dose, then the
 * higher Qloo affinity). One per week, so the rest of the week stays new.
 */
export function keptCandidate<T extends { entity_id: string; rung: string; affinity: number }>(cards: readonly T[], ratings: readonly Rating[]): { card: T; pleasure: number } | null {
  const byId = new Map(cards.map((c) => [c.entity_id, c]));
  const ranked = ratings
    .filter((r) => r.pleasure >= 7 && byId.has(r.entity_id))
    .map((r) => ({ card: byId.get(r.entity_id)!, pleasure: r.pleasure }))
    .sort((a, b) => b.pleasure - a.pleasure || Number(b.card.rung !== "home") - Number(a.card.rung !== "home") || b.card.affinity - a.card.affinity);
  return ranked[0] ?? null;
}

function dedupe<T>(xs: T[], key: (x: T) => string): T[] {
  const seen = new Set<string>();
  return xs.filter((x) => (seen.has(key(x)) ? false : (seen.add(key(x)), true)));
}
