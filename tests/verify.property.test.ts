/**
 * Property-based verification of the truth layer (lib/verify.ts), with fast-check.
 *
 * The examples in verify.test.ts pin specific captured Qloo shapes. These properties sweep the input space instead:
 * random tag sets drawn from the deny list, the REVIEW list and harmless activity tags, random names, opening hours,
 * slots, distances, prices and constraints. Seeds are fixed, so the run (and the case count) is reproducible.
 *
 *   P1  a PASS outing satisfies every hard constraint of its case (open at the slot, near, in budget, an activity,
 *       quiet / wheelchair when required, not rated low, not struck by the clinician)
 *   P2  in recovery, an outing carrying ANY deny-listed alcohol tag is REFUSED, never PASS and never only REVIEW
 *   P3  hours that are missing for the slot's day are never treated as open (UNKNOWN = refused)
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { ALCOHOL_DENY_TAGS, ALCOHOL_REVIEW_TAGS, DAYS, slotStatus, verifyCard, type CaseConstraints, type DayName } from "@/lib/verify";
import type { DayHours, QlooEntity, WeekHours } from "@/lib/qloo";
import { TAG_QUIET, TAG_WHEELCHAIR } from "@/lib/tags";

/** Runs per property. The README states the total (3 × RUNS). */
export const RUNS = 20_000;

const DENY = [...ALCOHOL_DENY_TAGS];
const REVIEW = [...ALCOHOL_REVIEW_TAGS];
const HARMLESS = [
  "urn:tag:category:place:museum",
  "urn:tag:category:place:park",
  "urn:tag:category:place:cafe",
  "urn:tag:category:place:book_store",
  "urn:tag:category:place:restaurant",
  "urn:tag:genre:place:restaurant:thai",
  "urn:tag:category:place:butcher_shop",
  "urn:tag:category:place:tattoo_shop",
  "urn:tag:offerings:place:coffee",
  "urn:tag:amenity:qloo:wifi",
  "urn:tag:beverage_offering:qloo:specialty_non_alcoholic",
  TAG_QUIET,
  TAG_WHEELCHAIR,
];
const NAMES = ["Quiet Pages", "Tea Bar & Books", "The Tavern", "Juice Bar", "Brooklyn Museum", "Barbecue Spot", "Wine Cellar", "Park Café", "Corner Bakery"];

const clock = fc.tuple(fc.integer({ min: 0, max: 23 }), fc.constantFrom(0, 30)).map(([h, m]) => `T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`);
// weighted so a real share of venues are placeable (P1 asserts it is not vacuous): mostly open 06:00–23:00
const dayHours: fc.Arbitrary<DayHours[] | undefined> = fc.oneof(
  { weight: 1, arbitrary: fc.constant<DayHours[] | undefined>(undefined) },
  { weight: 1, arbitrary: fc.constant<DayHours[]>([{ opens: null, closes: null, closed: true }]) },
  { weight: 2, arbitrary: fc.array(fc.record({ opens: clock, closes: clock }), { minLength: 1, maxLength: 2 }) },
  { weight: 6, arbitrary: fc.constant<DayHours[]>([{ opens: "T06:00:00", closes: "T23:00:00" }]) },
);
const hours: fc.Arbitrary<WeekHours> = fc.record(Object.fromEntries(DAYS.map((d) => [d, dayHours])) as Record<DayName, typeof dayHours>);
const ACTIVITY = HARMLESS.slice(0, 6);
const tags = fc
  .tuple(
    fc.subarray(ACTIVITY, { minLength: 1, maxLength: 2 }),
    fc.subarray([TAG_QUIET, TAG_WHEELCHAIR]),
    fc.uniqueArray(fc.constantFrom(...HARMLESS, ...REVIEW, ...DENY), { maxLength: 4 }),
    fc.boolean(),
  )
  .map(([act, access, extra, clean]) => [...new Set([...act, ...access, ...(clean ? [] : extra)])].map((id) => ({ id })));

const entity = fc.record({
  entity_id: fc.oneof({ weight: 9, arbitrary: fc.uuid() }, { weight: 1, arbitrary: fc.constant("") }),
  name: fc.constantFrom(...NAMES),
  tags,
  properties: fc.record({
    hours,
    price_level: fc.option(fc.integer({ min: 1, max: 4 }), { nil: undefined }),
    is_closed: fc.oneof({ weight: 1, arbitrary: fc.constant(true) }, { weight: 4, arbitrary: fc.constant(false) }, { weight: 4, arbitrary: fc.constant(null) }),
  }),
  query: fc.record({ distance: fc.option(fc.integer({ min: 0, max: 4000 }), { nil: undefined }) }),
}) as fc.Arbitrary<QlooEntity>;

const constraints: fc.Arbitrary<CaseConstraints> = fc.record({
  maxMeters: fc.integer({ min: 300, max: 3000 }),
  priceMax: fc.integer({ min: 1, max: 3 }),
  inRecovery: fc.boolean(),
  needQuiet: fc.boolean(),
  needWheelchair: fc.boolean(),
});
const slot = fc.record({ day: fc.constantFrom(...DAYS) as fc.Arbitrary<DayName>, hour: fc.integer({ min: 7, max: 21 }) });

describe("verifier properties (fast-check, fixed seeds)", () => {
  it("P1: a PASS outing satisfies every hard constraint of its case", () => {
    let passed = 0;
    fc.assert(
      fc.property(entity, constraints, slot, fc.integer({ min: 0, max: 9 }), (e, c, s, hist) => {
        const lowRated = hist === 0;
        const struck = hist === 1;
        const ids = new Set(e.entity_id ? [e.entity_id] : []);
        const r = verifyCard(e, { kind: "outing", constraints: c, slot: s, lowRated: lowRated ? ids : new Set(), struck: struck ? ids : new Set() });
        if (r.verdict !== "PASS") return;
        passed++;
        const tagSet = new Set((e.tags ?? []).map((t) => t.id));
        expect(e.entity_id).not.toBe("");
        expect(lowRated || struck).toBe(false);
        expect(e.properties?.is_closed).not.toBe(true);
        expect(slotStatus(e.properties?.hours, s.day, s.hour).status).toBe("OPEN");
        expect(e.query?.distance).toBeTypeOf("number");
        expect(e.query!.distance!).toBeLessThanOrEqual(c.maxMeters);
        if (typeof e.properties?.price_level === "number") expect(e.properties.price_level).toBeLessThanOrEqual(c.priceMax);
        if (c.needQuiet) expect(tagSet.has(TAG_QUIET)).toBe(true);
        if (c.needWheelchair) expect(tagSet.has(TAG_WHEELCHAIR)).toBe(true);
        if (c.inRecovery) for (const id of tagSet) expect(ALCOHOL_DENY_TAGS.has(id!)).toBe(false);
      }),
      { numRuns: RUNS, seed: 20261007 },
    );
    expect(passed).toBeGreaterThan(RUNS / 100); // non-vacuous: the generator does produce placeable venues
  });

  it("P2: in recovery, any deny-listed alcohol tag is REFUSED (never PASS, never only REVIEW)", () => {
    fc.assert(
      fc.property(entity, constraints, slot, fc.constantFrom(...DENY), (e, c, s, deny) => {
        const withDeny = { ...e, tags: [...(e.tags ?? []), { id: deny }] };
        const r = verifyCard(withDeny, { kind: "outing", constraints: { ...c, inRecovery: true }, slot: s });
        expect(r.verdict).toBe("REFUSE");
        expect(r.reasons.some((x) => x.rule === "R-ALC" && x.verdict === "REFUSE")).toBe(true);
      }),
      { numRuns: RUNS, seed: 20261008 },
    );
  });

  it("P3: hours missing for the slot's day are never treated as open", () => {
    let checked = 0;
    fc.assert(
      fc.property(hours, slot, (h, s) => {
        const prev = DAYS[(DAYS.indexOf(s.day) + 6) % 7];
        const noToday: WeekHours = { ...h, [s.day]: undefined };
        const prevIvs = [noToday[prev] ?? []].flat();
        const prevHasOvernight = prevIvs.some((iv) => !iv.closed && iv.opens !== null && iv.closes !== null && iv.closes < iv.opens);
        if (prevHasOvernight) return; // an overnight interval from the day before may legitimately cover the morning
        checked++;
        expect(slotStatus(noToday, s.day, s.hour).status).toBe("UNKNOWN");
      }),
      { numRuns: RUNS, seed: 20261009 },
    );
    expect(checked).toBeGreaterThan(RUNS / 2);
  });
});
