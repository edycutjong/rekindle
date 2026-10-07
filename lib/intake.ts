/**
 * Server-side check of the loves an intake POST claims the clinician confirmed (QA round 3: the route trusted the
 * client — duplicates, made-up IDs that were then sent to Qloo as signals, and free text shown as a "loved" chip).
 *
 *   format   entity IDs are Qloo UUIDs, tag IDs start with `urn:tag:`; one love per ID
 *   screen   the typed text passes the same deny list as /api/resolve (no clinical words or contact data)
 *   resolve  entity IDs: one batched GET /entities; tag IDs: the typed text is looked up again with /v2/tags and the
 *            ID must be among the matches. The stored `name` is always Qloo's, never the client's.
 */
import { QlooError, type QlooClient } from "./qloo";
import { LOVE_KINDS, screenLoveText } from "./resolve";

export class BadInput extends Error {
  constructor(m: string) {
    super(m);
    this.name = "BadInput";
  }
}

export const ENTITY_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const TAG_ID_RE = /^urn:tag:[a-z0-9_]+(:[a-z0-9_.-]+)+$/i;
const ENTITY_TYPES = new Set(LOVE_KINDS.filter((k) => !k.endsWith("_tag")).map((k) => `urn:entity:${k}`));

export interface LoveIn {
  text: string;
  qloo_id: string;
  qloo_kind: "entity" | "tag";
  entity_type?: string;
  name?: string;
}

export interface LoveOut {
  text: string;
  qloo_id: string;
  qloo_kind: "entity" | "tag";
  entity_type?: string;
  name: string;
}

/** Shape-only checks (no Qloo request): unique IDs, ID format per kind, entity type, the text screen. */
export function checkLoveShapes(loves: readonly LoveIn[]): void {
  const ids = loves.map((l) => l.qloo_id.toLowerCase());
  if (new Set(ids).size !== ids.length) throw new BadInput("each love must be a different Qloo entity or tag");
  for (const l of loves) {
    if (l.qloo_kind === "entity" && !ENTITY_ID_RE.test(l.qloo_id)) throw new BadInput(`"${l.text}" does not carry a Qloo entity ID`);
    if (l.qloo_kind === "tag" && !TAG_ID_RE.test(l.qloo_id)) throw new BadInput(`"${l.text}" does not carry a Qloo tag ID`);
    if (l.qloo_kind === "entity" && l.entity_type && !ENTITY_TYPES.has(l.entity_type)) throw new BadInput(`"${l.text}" has an unsupported entity type`);
    const why = screenLoveText(l.text);
    if (why) throw new BadInput(`"${l.text}": ${why}`);
  }
}

/** Re-resolve every love against Qloo; throws BadInput naming the first love Qloo does not confirm. */
export async function verifyLoves(qloo: QlooClient, loves: readonly LoveIn[]): Promise<LoveOut[]> {
  checkLoveShapes(loves);
  const entityIds = loves.filter((l) => l.qloo_kind === "entity").map((l) => l.qloo_id);
  const found = new Map<string, { name: string; types: string[] }>();
  if (entityIds.length) {
    const r = await qloo.entities(entityIds).catch((e) => {
      // Qloo answers 400 "entity_ids should be an array of valid UUIDs" for a well-formed but impossible ID
      if (e instanceof QlooError && e.status === 400) throw new BadInput("Qloo refused one of the confirmed entity IDs");
      throw e;
    });
    for (const e of r.results ?? []) found.set(e.entity_id.toLowerCase(), { name: e.name, types: e.types ?? (e.type ? [e.type] : []) });
  }
  const out: LoveOut[] = [];
  for (const l of loves) {
    if (l.qloo_kind === "entity") {
      const e = found.get(l.qloo_id.toLowerCase());
      if (!e) throw new BadInput(`Qloo does not know the entity confirmed for "${l.text}"`);
      const type = l.entity_type && (e.types.length === 0 || e.types.includes(l.entity_type)) ? l.entity_type : e.types.find((t) => ENTITY_TYPES.has(t));
      out.push({ text: l.text, qloo_id: l.qloo_id, qloo_kind: "entity", ...(type ? { entity_type: type } : {}), name: e.name });
    } else {
      const r = await qloo.tags(l.text, { take: 20 });
      const tag = (r.results?.tags ?? []).find((t) => (t.id ?? t.tag_id ?? "").toLowerCase() === l.qloo_id.toLowerCase());
      if (!tag) throw new BadInput(`Qloo does not return the tag confirmed for "${l.text}" when it is looked up again`);
      out.push({ text: l.text, qloo_id: l.qloo_id, qloo_kind: "tag", name: tag.name ?? l.text });
    }
  }
  return out;
}
