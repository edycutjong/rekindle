/**
 * resolveLove — intake resolution of a typed love to Qloo IDs (used by /api/resolve, the
 * same rule as scripts/seed.py). Entities via /search pinned to a type (P1: "Phoebe Bridgers" is an artist AND a
 * person); food / activity loves via /v2/tags (P2/P3: "ramen" is a tag, not the place named Ramen). The clinician
 * confirms one of the top 3; nothing is guessed when Qloo returns nothing.
 */
import type { QlooClient } from "./qloo";

export const LOVE_KINDS = ["artist", "tv_show", "movie", "book", "podcast", "album", "place_tag", "activity_tag"] as const;
export type LoveKind = (typeof LOVE_KINDS)[number];

export interface LoveCandidate {
  qloo_id: string;
  qloo_kind: "entity" | "tag";
  entity_type?: string;
  name: string;
}

/** Tag preference: place-genre tags drive place ranking (P14), then any place tag, then the rest. */
export function rankTags(ids: string[]): string[] {
  const score = (t: string) => (t.startsWith("urn:tag:genre:place:restaurant:") ? 0 : t.includes(":place") ? 1 : 2);
  return ids.map((t, i) => ({ t, i })).sort((a, b) => score(a.t) - score(b.t) || a.i - b.i).map((x) => x.t);
}

/**
 * Deterministic screen on text typed into a love box before it is sent to Qloo /search or /v2/tags (decision condition
 * 1: no health data to Qloo). It refuses clinical vocabulary and personal identifiers; it is a narrow deny list, not a
 * classifier, so the intake note still tells the clinician to type only the taste. Returns the reason, or null.
 */
const HEALTH = /\b(diagnos\w*|phq-?\s?\d*|gad-?\s?7|suicid\w*|ideation|self[- ]?harm\w*|overdos\w*|psychiatr\w*|psychos[ie]s|bipolar|schizo\w*|ptsd|medicat\w*|prescri\w*|ssri|sertraline|fluoxetine|\d+\s?mg|patient|mrn|dob|date of birth)\b/i;
const EMAIL = /[^\s@]+@[^\s@]+\.[a-z]{2,}/i;
const PHONE = /(?:\d[\s().-]?){7,}/;
const ID_NUMBER = /\b\d{3}-\d{2}-\d{4}\b/;

export function screenLoveText(text: string): string | null {
  if (HEALTH.test(text)) return "this looks like health information; type only the taste (an artist, show, food), never clinical details";
  if (EMAIL.test(text) || PHONE.test(text) || ID_NUMBER.test(text)) return "this looks like personal contact or ID data; type only the taste";
  return null;
}

export async function resolveLove(qloo: QlooClient, text: string, kind: LoveKind): Promise<LoveCandidate[]> {
  const q = text.trim().slice(0, 120);
  if (!q) return [];
  if (screenLoveText(q)) return [];
  if (kind === "place_tag" || kind === "activity_tag") {
    const r = await qloo.tags(q, { take: 20 });
    const tags = r.results?.tags ?? [];
    const byId = new Map(tags.map((t) => [t.id ?? t.tag_id ?? "", t]));
    return rankTags([...byId.keys()].filter(Boolean))
      .slice(0, 3)
      .map((id) => ({ qloo_id: id, qloo_kind: "tag" as const, name: byId.get(id)?.name ?? q }));
  }
  const type = `urn:entity:${kind}`;
  const r = await qloo.search(q, { types: [type], take: 3 });
  return (r.results ?? []).slice(0, 3).map((h) => ({ qloo_id: h.entity_id, qloo_kind: "entity" as const, entity_type: type, name: h.name }));
}
