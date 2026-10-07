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
  kept: { day: DayName; name: string }[];
  added: { day: DayName; name: string; because: { name: string; score: number }[] }[];
  removed: { day: DayName; name: string; reason: string }[];
  /**
   * Week-2 cards whose explainability names a rekindled (≥ 7) entity. Qloo spreads explainability across every signal
   * entity, so almost every week-2 card names every rekindled entity; `top` marks the stronger claim — the rekindled
   * entity is that card's highest-weighted input. The UI draws an ember thread only for `top` links.
   */
  ember: { from: string; from_id: string; to: string; to_id: string; day: DayName; score: number; top: boolean }[];
}

export function diffWeeks(w1: WeekPlan, w2: WeekPlan, h: PlanHistory): ReplanDiff {
  const ids1 = new Set(w1.slots.flatMap((s) => (s.card ? [s.card.entity_id] : [])));
  const ids2 = new Set(w2.slots.flatMap((s) => (s.card ? [s.card.entity_id] : [])));
  const rek = new Map(h.rekindled.map((r) => [r.entity_id, r.name]));
  const out: ReplanDiff = { kept: [], added: [], removed: [], ember: [] };
  for (const s of w2.slots) {
    if (!s.card) continue;
    if (ids1.has(s.card.entity_id)) out.kept.push({ day: s.slot.day, name: s.card.name });
    else out.added.push({ day: s.slot.day, name: s.card.name, because: s.card.why.map((w) => ({ name: w.name, score: w.score })) });
    const best = Math.max(0, ...s.card.why.map((w) => w.score));
    for (const w of s.card.why) {
      if (!rek.has(w.entity_id) || w.score <= 0) continue;
      out.ember.push({ from: rek.get(w.entity_id)!, from_id: w.entity_id, to: s.card.name, to_id: s.card.entity_id, day: s.slot.day, score: w.score, top: w.score === best });
    }
  }
  for (const s of w1.slots) {
    if (!s.card || ids2.has(s.card.entity_id)) continue;
    out.removed.push({ day: s.slot.day, name: s.card.name, reason: h.lowRated.includes(s.card.entity_id) ? "rated ≤3 — excluded" : rek.has(s.card.entity_id) ? "rated ≥7 — now a Qloo signal for this week" : "replaced by a re-planned pick" });
  }
  return out;
}

/** Seed rating rule (seed-data.md): top at-home card P7, top outing P8, lowest outing P2. Needs ≥ 2 verified outings. */
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

function dedupe<T>(xs: T[], key: (x: T) => string): T[] {
  const seen = new Set<string>();
  return xs.filter((x) => (seen.has(key(x)) ? false : (seen.add(key(x)), true)));
}
