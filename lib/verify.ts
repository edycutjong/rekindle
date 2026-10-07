/**
 * Deterministic verifier — the truth layer. Pure TypeScript, no I/O.
 *
 * The LLM chooses where to look; Qloo and this file decide what is true. Every candidate that reaches the week ledger
 * passes these rules against the CASE row (never against tool params), and every refusal carries its rule and reason.
 *
 *   R-ID     has a Qloo entity_id (and, when given, one returned by Qloo in this run)
 *   R-OPEN   open at the slot per properties.hours[day] (overnight wrap handled; null hours = UNKNOWN = refused)
 *   R-NEAR   query.distance ≤ case max_meters
 *   R-PRICE  properties.price_level ≤ case price_max (when Qloo reports a price level)
 *   R-ALC    in recovery: exact deny-listed tag IDs + token screen with an allow list; ambiguous → REVIEW
 *   R-KIND   the place is a behavioural-activation activity category (museum, park, café, restaurant, studio…)
 *   R-QUIET  need_quiet → carries noise_level:qloo:quiet
 *   R-ACCESS need_wheelchair → carries accessibility:place:wheelchair_accessible_entrance
 *   R-HIST   not previously rated ≤ 3, and not swapped out / removed by the clinician in an earlier week
 */
import type { DayHours, QlooEntity, WeekHours } from "./qloo";
import { ALCOHOL_EXCLUDE_14, TAG_QUIET, TAG_WHEELCHAIR } from "./tags";

export type Verdict = "PASS" | "REFUSE" | "REVIEW";
export type RuleId = "R-ID" | "R-OPEN" | "R-NEAR" | "R-PRICE" | "R-ALC" | "R-KIND" | "R-QUIET" | "R-ACCESS" | "R-HIST";
export const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
export type DayName = (typeof DAYS)[number];

export interface RuleResult {
  rule: RuleId;
  verdict: Verdict;
  detail: string;
}

export interface CaseConstraints {
  maxMeters: number;
  priceMax: number;
  inRecovery: boolean;
  needQuiet: boolean;
  needWheelchair: boolean;
}

export interface Slot {
  day: DayName;
  hour: number;
  minute?: number;
}

export interface VerifyOptions {
  kind: "outing" | "home";
  constraints: CaseConstraints;
  slot?: Slot; // required for outings
  /** entity IDs the patient rated ≤ 3 */
  lowRated?: ReadonlySet<string>;
  /** entity IDs the clinician swapped out or removed in an earlier week (the gate's refusals are remembered) */
  struck?: ReadonlySet<string>;
  /** entity IDs Qloo returned in this run; when given, R-ID also requires membership */
  seenIds?: ReadonlySet<string>;
  /** bench ablation only: false disables R-ALC's screen (all other rules stay on) */
  alcoholScreen?: boolean;
}

export interface VerifyResult {
  verdict: Verdict;
  /** non-PASS results only, in rule order */
  reasons: RuleResult[];
  /** every rule evaluated */
  checks: RuleResult[];
}

/* ------------------------------------------------------------------ tags */

/** Tag IDs of an entity; /v2/insights uses `id`, /search uses `tag_id` (P23). */
export function tagIds(e: Pick<QlooEntity, "tags">): string[] {
  return (e.tags ?? []).map((t) => t.id ?? t.tag_id ?? "").filter(Boolean);
}

/* ------------------------------------------------------------------ R-OPEN */

export type SlotStatus = "OPEN" | "CLOSED" | "UNKNOWN";

/** "T08:00:00" | "T08:00" | "08:00" → minutes since midnight; null if unparseable. */
export function parseClock(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = /^T?(\d{1,2}):(\d{2})/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59) return null;
  return h * 60 + min;
}

const fmt = (mins: number) => `${String(Math.floor(mins / 60) % 24).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
const SHORT: Record<DayName, string> = { monday: "Mon", tuesday: "Tue", wednesday: "Wed", thursday: "Thu", friday: "Fri", saturday: "Sat", sunday: "Sun" };

function dayIntervals(hours: WeekHours | undefined | null, day: DayName): DayHours[] | null {
  if (!hours) return null;
  const h = hours as Record<string, DayHours[] | DayHours | undefined | null>;
  const v = h[day] ?? h[day[0].toUpperCase() + day.slice(1)];
  if (v === undefined || v === null) return null;
  return Array.isArray(v) ? v : [v];
}

export interface SlotCheck {
  status: SlotStatus;
  /** Qloo marks the whole day closed:true */
  dayClosed: boolean;
  /** human-readable hours for that day, e.g. "Thu 08:00–18:00" */
  hoursText: string;
  detail: string;
}

/**
 * Is the venue open at day/hour:minute? Three verdicts: OPEN, CLOSED, UNKNOWN (never assumed open).
 * Overnight wrap: "18:00–04:00" covers 23:00 the same day and 02:00 the next day.
 */
export function slotStatus(hours: WeekHours | undefined | null, day: DayName, hour: number, minute = 0): SlotCheck {
  const t = hour * 60 + minute;
  const today = dayIntervals(hours, day);
  const prevDay = DAYS[(DAYS.indexOf(day) + 6) % 7];
  const prev = dayIntervals(hours, prevDay) ?? [];

  // the previous day's overnight interval reaching into this morning
  for (const iv of prev) {
    const o = parseClock(iv.opens);
    const c = parseClock(iv.closes);
    if (iv.closed || o === null || c === null) continue;
    if (c < o && t < c) {
      return { status: "OPEN", dayClosed: false, hoursText: `${SHORT[prevDay]} ${fmt(o)}–${fmt(c)}`, detail: `open (overnight from ${SHORT[prevDay]}) until ${fmt(c)}` };
    }
  }

  if (!today || today.length === 0) {
    return { status: "UNKNOWN", dayClosed: false, hoursText: `${SHORT[day]} hours unknown`, detail: `no ${SHORT[day]} hours in Qloo` };
  }
  const dayClosed = today.some((iv) => iv.closed === true);
  if (dayClosed) {
    return { status: "CLOSED", dayClosed: true, hoursText: `${SHORT[day]} closed`, detail: `closed all ${SHORT[day]}` };
  }

  let anyUnknown = false;
  const known: string[] = [];
  for (const iv of today) {
    const o = parseClock(iv.opens);
    const c = parseClock(iv.closes);
    if (o === null || c === null) {
      anyUnknown = true;
      continue;
    }
    known.push(`${fmt(o)}–${fmt(c)}`);
    if (o === c) {
      if (o === 0) return { status: "OPEN", dayClosed: false, hoursText: `${SHORT[day]} 24h`, detail: "open 24 hours" };
      anyUnknown = true; // zero-length interval other than midnight: not interpretable
      continue;
    }
    const wraps = c < o;
    if ((wraps && t >= o) || (!wraps && t >= o && t < c)) {
      return { status: "OPEN", dayClosed: false, hoursText: `${SHORT[day]} ${known.join(", ")}`, detail: `open ${fmt(o)}–${fmt(c)}` };
    }
  }
  const hoursText = known.length ? `${SHORT[day]} ${known.join(", ")}` : `${SHORT[day]} hours unknown`;
  if (anyUnknown && known.length === 0) return { status: "UNKNOWN", dayClosed: false, hoursText, detail: `${SHORT[day]} hours are null in Qloo` };
  if (anyUnknown) return { status: "UNKNOWN", dayClosed: false, hoursText, detail: `${SHORT[day]} hours partly null in Qloo` };
  // explain the miss in the terms a clinician reads: "closes 18:00" / "opens 08:00"
  const first = today.map((iv) => [parseClock(iv.opens)!, parseClock(iv.closes)!] as const);
  const closesBefore = first.filter(([o, c]) => c >= o && c <= t);
  const opensAfter = first.filter(([o]) => o > t);
  const detail = opensAfter.length && !closesBefore.length ? `opens ${fmt(opensAfter[0][0])}` : closesBefore.length ? `closes ${fmt(closesBefore[closesBefore.length - 1][1])}` : `closed at ${fmt(t)}`;
  return { status: "CLOSED", dayClosed: false, hoursText, detail };
}

/**
 * Re-slot on R-OPEN (assembler): the latest of the day's free hours at which the venue is open, or null.
 * Unknown hours are never re-slotted.
 */
export function reslotHour(hours: WeekHours | undefined | null, day: DayName, freeHours: readonly number[]): number | null {
  const open = [...freeHours].sort((a, b) => b - a).find((h) => slotStatus(hours, day, h).status === "OPEN");
  return open ?? null;
}

/* ------------------------------------------------------------------ R-ALC */

/** Exact tag IDs that mean "serves alcohol" — the 14 exclusion tags plus everything the D1/P19 captures leaked. */
export const ALCOHOL_DENY_TAGS: ReadonlySet<string> = new Set<string>([
  ...ALCOHOL_EXCLUDE_14,
  // P19 leaks
  "urn:tag:beverage_offering:qloo:specialty_alcoholic",
  "urn:tag:beverage_offering:qloo:craft_beer",
  "urn:tag:amenity:qloo:craft_beer_selection",
  // offerings family
  "urn:tag:offerings:place:alcohol",
  "urn:tag:offerings:place:beer",
  "urn:tag:offerings:place:wine",
  "urn:tag:offerings:place:hard_liquor",
  "urn:tag:offerings:place:cocktails",
  "urn:tag:offerings:place:craft_beer",
  "urn:tag:offerings:place:happy_hour_drinks",
  "urn:tag:offerings:place:sake",
  // beverage family
  "urn:tag:beverage_offering:qloo:spirits",
  "urn:tag:beverage_offering:qloo:sake",
  "urn:tag:beverage_offering:qloo:soju",
  "urn:tag:beverage_offering:qloo:specialty_cocktails",
  // venue categories
  "urn:tag:category:place:liquor_store",
  "urn:tag:category:place:lounge_bar",
  "urn:tag:category:place:sports_bar",
  "urn:tag:category:place:gay_bar",
  "urn:tag:category:place:bar_grill",
  "urn:tag:category:place:winery",
  "urn:tag:category:place:gay_night_club",
  "urn:tag:genre:place:restaurant:cocktail_bar",
  "urn:tag:genre:place:restaurant:wine_bar",
  "urn:tag:genre:place:restaurant:distillery",
  "urn:tag:genre:place:restaurant:lounge_bar",
  "urn:tag:genre:place:restaurant:sports_bar",
  "urn:tag:genre:place:restaurant:gay_bar",
  "urn:tag:genre:place:restaurant:bar_grill",
  "urn:tag:genre:place:liquor_store",
  "urn:tag:genre:place:night_club",
  "urn:tag:genre:place:gay_night_club",
  "urn:tag:genre:place:winery",
  // amenities / service
  "urn:tag:amenity:qloo:alcohol",
  "urn:tag:amenity:qloo:alcohol_service",
  "urn:tag:amenity:qloo:full_bar",
  "urn:tag:amenity:qloo:beer",
  "urn:tag:amenity:qloo:wine",
  "urn:tag:amenity:qloo:draft_beer",
  "urn:tag:amenity:qloo:cocktail_bar",
  "urn:tag:amenity:qloo:cocktail_lounge",
  "urn:tag:amenity:qloo:on_site_bar",
  "urn:tag:amenity:qloo:wine_list",
  "urn:tag:amenity:qloo:wine_selection",
  "urn:tag:service_type:qloo:bar_service",
  "urn:tag:setting:qloo:cocktail_lounge",
  "urn:tag:setting:qloo:nightclub",
  "urn:tag:setting:qloo:neighborhood_bar",
  "urn:tag:setting:qloo:street_level_bar",
  "urn:tag:setting:qloo:distillery",
  "urn:tag:cuisine:qloo:cocktail_bar",
  "urn:tag:cuisine:qloo:cocktails",
  "urn:tag:cuisine:qloo:distillery",
  "urn:tag:cuisine:qloo:winery",
  "urn:tag:culinary_style:qloo:bar",
]);

/** Tags that suggest alcohol but do not prove it (P10 Dobbin St, P19 Mission Sandwich Social) → clinician REVIEW. */
export const ALCOHOL_REVIEW_TAGS: ReadonlySet<string> = new Set<string>([
  "urn:tag:amenity:qloo:bar_seating",
  "urn:tag:amenity:qloo:barstool_seating",
  "urn:tag:amenity:qloo:bar_area",
  "urn:tag:amenity:qloo:bar_ordering",
  "urn:tag:amenity:qloo:sustainable_bar",
  "urn:tag:amenity:qloo:tasting_bar",
  "urn:tag:offerings:place:food_at_bar",
  // D9 bench pools: on coffee chains these mean "coffee deals" / "drinks-only order is fine", not alcohol
  "urn:tag:offerings:place:happy_hour",
  "urn:tag:offerings:place:ok_to_order_just_drinks",
  "urn:tag:amenity:qloo:bar_stools",
]);

/** Tag namespaces describing the area or the audience, not what the venue serves — never screened. */
const IGNORED_NAMESPACES = ["urn:tag:nearby_attraction:", "urn:tag:keyword:media:", "urn:tag:style:", "urn:tag:audience:", "urn:tag:age_range:"];

/** Last-segment tokens that mean alcohol (`craft_beer`, `wine_flights` …). Token match, never substring (P10). */
const ALC_TOKENS = new Set(["alcohol", "alcoholic", "beer", "beers", "wine", "wines", "cocktail", "cocktails", "spirits", "liquor", "distillery", "brewery", "winery", "sake", "soju", "pub", "tavern", "saloon", "taproom", "nightclub", "bourbon", "whiskey", "whisky", "mezcal", "tequila"]);
/** Allow tokens/segments that contain an alcohol-looking token but are not alcohol (P10, P19). */
const ALC_ALLOW_SEGMENTS = new Set(["specialty_non_alcoholic", "non_alcoholic", "soft_drinks", "wellness_drinks", "home_brewing", "brewing_gear", "cold_brew", "nitro_cold_brew"]);
/** `<x>_bar` segments that are not drinking establishments. */
const BAR_ALLOW = new Set(["topping_bar", "sundae_bar", "waffle_bar", "taco_bar", "noodle_bar", "ramen_bar", "espresso_bar", "coffee_bar", "juice_bar", "juice_and_smoothie_bar", "chai_bar", "salad_bar", "tea_bar", "dessert_bar", "milk_bar", "poke_bar", "smoothie_bar", "nail_bar", "oxygen_bar", "cheese_bar_nearby"]);
/** `bar_<x>` segments that do mean a drinks service (the rest of `bar_*` is furniture → REVIEW). */
const BAR_SERVICE = new Set(["bar_service", "bar_onsite", "bar_menu", "bar_program", "bar_scene", "bar_crawl"]);
/** Namespaces where a hit is a soft signal (who goes there / what it suits), not what the venue serves → REVIEW. */
const SOFT_NAMESPACES = ["urn:tag:interests:", "urn:tag:customer_identity:", "urn:tag:activity_type:", "urn:tag:event:", "urn:tag:resy:"];

/** Venue-name screen: tokens that mark a drinking establishment, with allow phrases (P10: "Tea Bar"). */
const NAME_DENY = new Set(["bar", "pub", "tavern", "brewery", "brewing", "brewhouse", "distillery", "winery", "saloon", "taproom", "cocktail", "cocktails", "biergarten", "beer", "wine", "speakeasy", "lounge"]);
const NAME_ALLOW_PHRASES = ["tea bar", "espresso bar", "juice bar", "chai bar", "salad bar", "coffee bar", "smoothie bar", "dessert bar", "milk bar", "poke bar", "nail bar", "raw bar", "oxygen bar", "cereal bar", "candy bar"];

export interface AlcoholHit {
  source: "tag" | "token" | "name";
  value: string;
  verdict: "REFUSE" | "REVIEW";
}

function segment(tag: string): string {
  return tag.slice(tag.lastIndexOf(":") + 1);
}

export function alcoholScreen(e: Pick<QlooEntity, "tags" | "name">): { verdict: Verdict; hits: AlcoholHit[] } {
  const hits: AlcoholHit[] = [];
  for (const id of tagIds(e)) {
    if (ALCOHOL_DENY_TAGS.has(id)) {
      hits.push({ source: "tag", value: id, verdict: "REFUSE" });
      continue;
    }
    if (ALCOHOL_REVIEW_TAGS.has(id)) {
      hits.push({ source: "tag", value: id, verdict: "REVIEW" });
      continue;
    }
    if (IGNORED_NAMESPACES.some((ns) => id.startsWith(ns))) continue;
    const seg = segment(id);
    if (ALC_ALLOW_SEGMENTS.has(seg) || BAR_ALLOW.has(seg)) continue;
    const tokens = seg.split("_");
    const isBar = seg === "bar" || BAR_SERVICE.has(seg) || (seg.endsWith("_bar") && !BAR_ALLOW.has(seg));
    // `bar_<x>` segments describe furniture or ordering (bar_stools, bar_area), and `happy_hour` alone is a price deal:
    // a signal for the clinician, not proof of alcohol (D9 bench: 16 Handles, Dunkin', ROKA)
    const furniture = (seg.startsWith("bar_") && !BAR_SERVICE.has(seg)) || seg === "happy_hour";
    const tokenHit = tokens.some((tok) => ALC_TOKENS.has(tok)) || isBar || furniture;
    if (!tokenHit) continue;
    const soft = SOFT_NAMESPACES.some((ns) => id.startsWith(ns)) || (furniture && !tokens.some((tok) => ALC_TOKENS.has(tok)));
    hits.push({ source: "token", value: id, verdict: soft ? "REVIEW" : "REFUSE" });
  }
  const name = (e.name ?? "").toLowerCase();
  let scrubbed = name;
  for (const p of NAME_ALLOW_PHRASES) scrubbed = scrubbed.split(p).join(" ");
  const nameTokens = scrubbed.split(/[^a-z0-9']+/).filter(Boolean);
  const nameHit = nameTokens.find((t) => NAME_DENY.has(t));
  if (nameHit) hits.push({ source: "name", value: `name "${e.name}" (${nameHit})`, verdict: "REFUSE" });

  const verdict: Verdict = hits.some((h) => h.verdict === "REFUSE") ? "REFUSE" : hits.length ? "REVIEW" : "PASS";
  return { verdict, hits };
}

/* ------------------------------------------------------------------ R-KIND */

/** Category slugs (from `urn:tag:category:place:<slug>` / `urn:tag:genre:place:<slug>`) that are BA activities. */
const KIND_ALLOW_EXACT = new Set([
  "museum", "art_gallery", "art_center", "art_studio", "art_school", "pottery_classes", "pottery_store", "ceramics_studio",
  "park", "city_park", "state_park", "national_park", "garden", "botanical_garden", "nature_preserve", "hiking_area", "beach",
  "book_store", "comic_book_store", "used_book_store", "library", "public_library", "record_store", "music_store",
  "tea_house", "tea_store", "tea_market_place", "coffee_shop", "cafe", "espresso_bar", "cat_cafe",
  "bakery", "donut_shop", "patisserie", "pastry_shop", "dessert_shop", "ice_cream_shop", "cake_shop", "cookie_shop", "bagel_shop", "juice_shop", "japanese_confectionery_shop", "chocolate_shop",
  "diner", "sandwich_shop", "salad_shop", "noodle_shop",
  "movie_theater", "cinema", "performing_arts_theater", "concert_hall", "live_music_venue", "theater_company", "opera_house",
  "cultural_center", "cultural_landmark", "historical_landmark", "historical_place", "aquarium", "zoo", "planetarium",
  "meditation_center", "yoga_studio", "dance_school", "ice_skating_rink", "climbing_gym", "bowling_alley",
  "flea_market", "market", "farmers_market", "plant_nursery",
]);
/** `<cuisine>_restaurant` and `restaurant:<cuisine>` are allowed except drinking or food-retail genres. */
const KIND_FOOD_DENY = new Set(["bar", "cocktail_bar", "wine_bar", "sports_bar", "lounge_bar", "gay_bar", "bar_grill", "distillery", "butcher_shop", "cheese_shop", "takeout", "delivery", "fast_food"]);
/**
 * Categories that disqualify a place even when Qloo also tags it with the generic `restaurant` category
 * (D1 capture: The Meat Hook and Marlow & Daughters are butchers tagged `restaurant`; P9 returned tattoo studios).
 */
const KIND_HARD_DENY = new Set(["butcher_shop", "restaurant:butcher_shop", "meat_products_store", "liquor_store", "tattoo_shop", "body_piercing_shop", "smoke_shop", "hotel", "motel", "night_club", "gay_night_club"]);
const KIND_DENY_HINT = /tattoo|clothing|boutique|jewel|hotel|motel|butcher|meat_products|liquor|smoke_shop|grocery|supermarket|department_store|shopping_mall|shoe_store|salon|spa$|personal_care|bank|pharmacy|gas_station|car_|motorcycle|night_club|bar$|pub$|brewery|distillery|winery|tavern|beer_|wine_store|taproom/;

/**
 * A `urn:tag:category:place:<slug>` that names a drinking establishment disqualifies the place for every case,
 * not only in recovery (B5 bench: "TeKu Tavern + Café" carries `cafe` AND `bar`/`beer_hall`/`cider_bar` and was
 * placed for a not-in-recovery profile). Only the `category:` namespace counts here; `genre:` tags are softer.
 */
const DRINK_CATEGORY = new Set(["pub", "brewpub", "brewery", "distillery", "winery", "beer_hall", "beer_garden", "taproom", "tavern", "beer_store", "wine_store", "saloon", "biergarten"]);
export function isDrinkingCategory(slug: string): boolean {
  if (DRINK_CATEGORY.has(slug)) return true;
  return slug === "bar" || (slug.endsWith("_bar") && !BAR_ALLOW.has(slug));
}

export function activityKind(e: Pick<QlooEntity, "tags">): { ok: boolean; matched?: string; categories: string[] } {
  const cats: string[] = [];
  const drink: string[] = [];
  for (const id of tagIds(e)) {
    const m = /^urn:tag:(?:category|genre):place:(.+)$/.exec(id);
    if (!m) continue;
    cats.push(m[1]);
    if (id.startsWith("urn:tag:category:place:") && isDrinkingCategory(m[1])) drink.push(m[1]);
  }
  if (drink.length) return { ok: false, categories: [drink[0], ...cats.filter((c) => c !== drink[0])] };
  const hard = cats.find((c) => KIND_HARD_DENY.has(c));
  if (hard) return { ok: false, categories: [hard, ...cats.filter((c) => c !== hard)] };
  // the generic `restaurant` category alone is not enough: Qloo puts it on butchers and grocers too
  for (const c of cats) {
    if (KIND_ALLOW_EXACT.has(c)) return { ok: true, matched: c, categories: cats };
    const food = /^restaurant:(.+)$/.exec(c)?.[1] ?? /^(.+)_restaurant$/.exec(c)?.[1];
    if (food && !KIND_FOOD_DENY.has(food)) return { ok: true, matched: c, categories: cats };
    if (/(^|_)museum$/.test(c)) return { ok: true, matched: c, categories: cats };
  }
  return { ok: false, categories: cats };
}

/* ------------------------------------------------------------------ verifyCard */

export function verifyCard(e: QlooEntity, opts: VerifyOptions): VerifyResult {
  const checks: RuleResult[] = [];
  const c = opts.constraints;
  const push = (rule: RuleId, verdict: Verdict, detail: string) => checks.push({ rule, verdict, detail });

  // R-ID
  if (!e?.entity_id) push("R-ID", "REFUSE", "no Qloo entity_id");
  else if (opts.seenIds && !opts.seenIds.has(e.entity_id)) push("R-ID", "REFUSE", "entity_id not returned by Qloo in this run");
  else push("R-ID", "PASS", e.entity_id);

  // R-HIST
  if (e?.entity_id && opts.lowRated?.has(e.entity_id)) push("R-HIST", "REFUSE", "rated ≤3 before");
  else if (e?.entity_id && opts.struck?.has(e.entity_id)) push("R-HIST", "REFUSE", "removed by the clinician before");
  else push("R-HIST", "PASS", "not rated low");

  if (opts.kind === "outing") {
    // R-OPEN
    if (!opts.slot) push("R-OPEN", "REFUSE", "no slot to check");
    else if (e.properties?.is_closed === true) push("R-OPEN", "REFUSE", "permanently closed in Qloo");
    else {
      const s = slotStatus(e.properties?.hours, opts.slot.day, opts.slot.hour, opts.slot.minute ?? 0);
      const at = `${String(opts.slot.hour).padStart(2, "0")}:${String(opts.slot.minute ?? 0).padStart(2, "0")}`;
      if (s.status === "OPEN") push("R-OPEN", "PASS", `${s.hoursText} · slot ${at}`);
      else if (s.status === "UNKNOWN") push("R-OPEN", "REFUSE", `unknown hours (${s.detail}) · slot ${at}`);
      else push("R-OPEN", "REFUSE", `${s.detail} · slot ${at}`);
    }
    // R-NEAR
    const d = typeof e.query?.distance === "number" ? e.query.distance : undefined;
    if (d === undefined) push("R-NEAR", "REFUSE", "distance unknown");
    else if (d > c.maxMeters) push("R-NEAR", "REFUSE", `${Math.round(d)} m > ${c.maxMeters} m`);
    else push("R-NEAR", "PASS", `${Math.round(d)} m`);
    // R-PRICE
    const p = e.properties?.price_level;
    if (typeof p === "number" && p > c.priceMax) push("R-PRICE", "REFUSE", `price level ${p} > ${c.priceMax}`);
    else push("R-PRICE", "PASS", typeof p === "number" ? `price level ${p}` : "no price level");
    // R-ALC
    if (c.inRecovery && opts.alcoholScreen !== false) {
      const a = alcoholScreen(e);
      if (a.verdict === "PASS") push("R-ALC", "PASS", "no alcohol signal");
      else push("R-ALC", a.verdict, a.hits.filter((h) => h.verdict === a.verdict).map((h) => (h.source === "name" ? h.value : h.value.replace("urn:tag:", ""))).join(", "));
    } else push("R-ALC", "PASS", c.inRecovery ? "screen off (ablation)" : "not in recovery");
    // R-KIND
    const k = activityKind(e);
    if (k.ok) push("R-KIND", "PASS", k.matched!);
    else push("R-KIND", "REFUSE", k.categories.length ? `not an activity: ${k.categories.find((x) => KIND_DENY_HINT.test(x)) ?? k.categories[0]}` : "no place category");
    // R-QUIET / R-ACCESS
    const tags = tagIds(e);
    if (c.needQuiet) push("R-QUIET", tags.includes(TAG_QUIET) ? "PASS" : "REFUSE", tags.includes(TAG_QUIET) ? "quiet" : "no quiet tag");
    if (c.needWheelchair) push("R-ACCESS", tags.includes(TAG_WHEELCHAIR) ? "PASS" : "REFUSE", tags.includes(TAG_WHEELCHAIR) ? "wheelchair entrance" : "no wheelchair-entrance tag");
  }

  const reasons = checks.filter((r) => r.verdict !== "PASS");
  const verdict: Verdict = reasons.some((r) => r.verdict === "REFUSE") ? "REFUSE" : reasons.length ? "REVIEW" : "PASS";
  return { verdict, reasons, checks };
}

/** Per-love explainability split for the why line ("because Phoebe Bridgers 0.54 · Fleabag 0.46"). */
export function explainSplit(e: Pick<QlooEntity, "query">): { entity_id: string; score: number }[] {
  const raw = (e.query?.explainability as Record<string, unknown> | undefined)?.["signal.interests.entities"];
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x): x is { entity_id: string; score: number } => typeof x?.entity_id === "string" && typeof x?.score === "number")
    .sort((a, b) => b.score - a.score);
}
