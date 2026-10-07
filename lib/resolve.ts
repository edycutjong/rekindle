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

export async function resolveLove(qloo: QlooClient, text: string, kind: LoveKind): Promise<LoveCandidate[]> {
  const q = text.trim().slice(0, 120);
  if (!q) return [];
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
