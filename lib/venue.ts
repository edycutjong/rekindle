/**
 * Venue verification for the bench (`/api/verify-venue`). Grades ONE named venue at ONE slot with the
 * same oracle for every arm:
 *
 *   by name + address (arm A, and arm B's symmetry check)
 *     1. geocode the stated street address with Nominatim (OSM) — 1 request/s, identifying User-Agent, bench only
 *     2. Qloo `/search?query=<name>&types=urn:entity:place&filter.location=<lat,lon>&filter.radius=<miles>` (P23)
 *     3. a match is a hit whose normalised name matches the stated name AND whose location is ≤ 300 m from the
 *        geocoded point (P23: `/search` is fuzzy, so never "first hit")
 *   by entity_id (arm B, Qloo-graded): `GET /entities?entity_ids=<id>`
 *
 * then the verifier's own rules on that Qloo record: hours at the slot (`slotStatus`; missing hours = UNKNOWN) and the
 * R-ALC screen (`alcoholScreen`). Qloo is the oracle here, which is the bias the blind manual audit exists to check.
 */
import { haversine } from "./plan";
import type { QlooClient, QlooEntity } from "./qloo";
import { alcoholScreen, DAYS, slotStatus, type DayName } from "./verify";

export const MATCH_RADIUS_M = 300;

export interface Geocode {
  lat: number;
  lon: number;
  display_name: string;
}

export type Geocoder = (address: string) => Promise<Geocode | null>;

export interface VenueQuery {
  name: string;
  address?: string;
  entity_id?: string;
  day: DayName;
  hour: number;
  /** optional: the patient's point, to report the distance (not part of the headline) */
  origin?: { lat: number; lon: number };
  /** bypass geocoding (tests / an address the caller already geocoded) */
  point?: { lat: number; lon: number };
}

export interface VenueVerdict {
  name: string;
  mode: "address" | "entity";
  geocode: Geocode | null;
  candidates: number;
  match: { entity_id: string; name: string; distance_m: number | null; address: string | null } | null;
  /** no geocode, or no name-matching Qloo place within 300 m (address mode); no Qloo entity (entity mode) */
  verifiable: boolean;
  slot: { status: "OPEN" | "CLOSED" | "UNKNOWN" | null; hours: string | null; detail: string | null };
  alcohol: { verdict: "PASS" | "REVIEW" | "REFUSE" | null; hits: string[] };
  distance_from_origin_m: number | null;
  error?: string;
}

const STOP = new Set(["the", "a", "an", "and", "of", "nyc", "co", "inc", "llc", "cafe", "café", "shop", "restaurant", "bar"]);

/** lower-case, strip accents and punctuation, "&" → "and", collapse whitespace */
export function normaliseName(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

const tokens = (s: string) => normaliseName(s).split(" ").filter((t) => t && !STOP.has(t));

/**
 * Same venue name? Equal after normalising, one contains the other (≥ 5 chars), or ≥ 2/3 of the shorter name's
 * distinctive tokens appear in the other. The ≤ 300 m test does the rest of the work.
 */
export function namesMatch(a: string, b: string): boolean {
  const x = normaliseName(a);
  const y = normaliseName(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (short.length >= 5 && (` ${long} `.includes(` ${short} `) || long.replace(/ /g, "").includes(short.replace(/ /g, "")))) return true;
  const ta = tokens(a);
  const tb = tokens(b);
  const [s, l] = ta.length <= tb.length ? [ta, new Set(tb)] : [tb, new Set(ta)];
  if (s.length === 0) return false;
  const hit = s.filter((t) => l.has(t)).length;
  return hit >= Math.max(1, Math.ceil((2 * s.length) / 3)) && (s.length > 1 || s[0]!.length >= 5);
}

function entityLatLon(e: QlooEntity): { lat: number; lon: number } | null {
  const l = e.location as { lat?: number; lon?: number; latitude?: number; longitude?: number } | undefined;
  const lat = l?.lat ?? l?.latitude;
  const lon = l?.lon ?? l?.longitude;
  return typeof lat === "number" && typeof lon === "number" ? { lat, lon } : null;
}

/** Hours at the slot + R-ALC on a Qloo place record (the same functions the planner's verifier uses). */
export function gradeEntity(e: QlooEntity, day: DayName, hour: number): Pick<VenueVerdict, "slot" | "alcohol"> {
  const closed = e.properties?.is_closed === true;
  const s = slotStatus(e.properties?.hours, day, hour);
  const a = alcoholScreen(e);
  return {
    slot: closed ? { status: "CLOSED", hours: s.hoursText, detail: "permanently closed in Qloo" } : { status: s.status, hours: s.hoursText, detail: s.detail },
    alcohol: { verdict: a.verdict, hits: a.hits.map((h) => h.value.replace("urn:tag:", "")) },
  };
}

/** Pick the closest name-matching hit within 300 m of the point. */
export function matchHit(name: string, point: { lat: number; lon: number }, hits: QlooEntity[]): { e: QlooEntity; d: number } | null {
  let best: { e: QlooEntity; d: number } | null = null;
  for (const e of hits) {
    const p = entityLatLon(e);
    if (!p || !namesMatch(name, e.name)) continue;
    const d = haversine(point.lat, point.lon, p.lat, p.lon);
    if (d <= MATCH_RADIUS_M && (!best || d < best.d)) best = { e, d };
  }
  return best;
}

const empty = (q: VenueQuery, mode: VenueVerdict["mode"]): VenueVerdict => ({
  name: q.name,
  mode,
  geocode: null,
  candidates: 0,
  match: null,
  verifiable: false,
  slot: { status: null, hours: null, detail: null },
  alcohol: { verdict: null, hits: [] },
  distance_from_origin_m: null,
});

export async function verifyVenue(qloo: QlooClient, geocode: Geocoder, q: VenueQuery): Promise<VenueVerdict> {
  if (!DAYS.includes(q.day)) throw new Error("invalid day");
  const fromOrigin = (p: { lat: number; lon: number } | null) => (p && q.origin ? Math.round(haversine(q.origin.lat, q.origin.lon, p.lat, p.lon)) : null);

  if (q.entity_id) {
    const out = empty(q, "entity");
    const r = await qloo.entities([q.entity_id]);
    const e = (r.results ?? []).find((x) => x.entity_id === q.entity_id);
    out.candidates = r.results?.length ?? 0;
    if (!e) return out;
    const p = entityLatLon(e);
    return {
      ...out,
      ...gradeEntity(e, q.day, q.hour),
      verifiable: true,
      match: { entity_id: e.entity_id, name: e.name, distance_m: null, address: typeof e.properties?.address === "string" ? e.properties.address : null },
      distance_from_origin_m: fromOrigin(p),
    };
  }

  const out = empty(q, "address");
  const g = q.point ? { ...q.point, display_name: "(point given)" } : q.address ? await geocode(q.address) : null;
  out.geocode = g;
  if (!g) return out;
  // 1 mile ≈ 1609 m: wide enough to contain the 300 m match circle with room for Qloo's own point
  const r = await qloo.search(q.name, { types: ["urn:entity:place"], take: 20, extra: { "filter.location": `${g.lat},${g.lon}`, "filter.radius": 1 } });
  const hits = r.results ?? [];
  out.candidates = hits.length;
  const m = matchHit(q.name, g, hits);
  if (!m) return out;
  return {
    ...out,
    ...gradeEntity(m.e, q.day, q.hour),
    verifiable: true,
    match: { entity_id: m.e.entity_id, name: m.e.name, distance_m: Math.round(m.d), address: typeof m.e.properties?.address === "string" ? m.e.properties.address : null },
    distance_from_origin_m: fromOrigin(entityLatLon(m.e)),
  };
}

/* ------------------------------------------------------------------ Nominatim */

const NOMINATIM = "https://nominatim.openstreetmap.org/search";
export const NOMINATIM_UA = "rekindle-bench/0.1 (+https://github.com/edycutjong/rekindle)";
let lastNominatim = 0;

/** Nominatim geocoder: ≤ 1 request/s per instance (usage policy), identifying User-Agent, first result only. */
export function nominatim(fetchImpl: typeof fetch = fetch, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): Geocoder {
  return async (address: string) => {
    const wait = lastNominatim + 1100 - Date.now();
    if (wait > 0) await sleep(wait);
    lastNominatim = Date.now();
    const url = `${NOMINATIM}?${new URLSearchParams({ q: address, format: "jsonv2", limit: "1", addressdetails: "0" })}`;
    const res = await fetchImpl(url, { headers: { "User-Agent": NOMINATIM_UA, Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`Nominatim ${res.status}`);
    const body = (await res.json()) as { lat: string; lon: string; display_name: string }[];
    const h = body[0];
    return h ? { lat: Number(h.lat), lon: Number(h.lon), display_name: h.display_name } : null;
  };
}
