import { describe, expect, it } from "vitest";
import type { QlooEntity, WeekHours } from "../lib/qloo";
import { ALCOHOL_EXCLUDE_14, TAG_QUIET, TAG_WHEELCHAIR } from "../lib/tags";
import { activityKind, alcoholScreen, explainSplit, parseClock, reslotHour, slotStatus, tagIds, verifyCard, type CaseConstraints } from "../lib/verify";
import { byName, captured } from "./fixtures";

const recoveryOff = captured("maya-thu-recovery-off");
const recovery14 = captured("maya-thu-recovery-on-14tags");
const searchHits = captured("search-dunwell-near-maya");

const MAYA: CaseConstraints = { maxMeters: 1500, priceMax: 2, inRecovery: false, needQuiet: false, needWheelchair: false };
const MAYA_RECOVERY: CaseConstraints = { ...MAYA, inRecovery: true };
const thu = (hour: number) => ({ day: "thursday" as const, hour });

/** P8 shapes, verbatim structure from live responses. */
const NULL_DAY = { opens: null, closes: null, closed: null };
const BABYS_ALL_RIGHT: WeekHours = { thursday: [{ opens: "T18:00:00", closes: "T04:00:00", closed: false }], friday: [{ opens: "T18:00:00", closes: "T04:00:00", closed: false }] };
const place = (over: Partial<QlooEntity>): QlooEntity => ({ entity_id: "X", name: "X", tags: [{ id: "urn:tag:category:place:cafe" }], query: { distance: 300 }, properties: { hours: { thursday: [{ opens: "T08:00:00", closes: "T20:00:00", closed: false }] } }, ...over });
const withTags = (...ids: string[]) => ids.map((id) => ({ id }));

describe("R-OPEN: slot vs properties.hours", () => {
  it("parses Qloo clock strings in all observed formats", () => {
    expect(parseClock("T08:00:00")).toBe(480);
    expect(parseClock("T18:30")).toBe(1110);
    expect(parseClock("07:15")).toBe(435);
    expect(parseClock(null)).toBeNull();
    expect(parseClock("nonsense")).toBeNull();
  });

  it("Dun-Well Doughnuts (captured) is open Thu 15:00 and refused at 18:00 with 'closes 18:00'", () => {
    const dw = byName(recovery14, "Dun-Well Doughnuts");
    expect(slotStatus(dw.properties?.hours, "thursday", 15).status).toBe("OPEN");
    const at18 = slotStatus(dw.properties?.hours, "thursday", 18);
    expect(at18.status).toBe("CLOSED");
    expect(at18.detail).toBe("closes 18:00");
    expect(at18.hoursText).toBe("Thu 08:00–18:00");
  });

  it("null opens/closes is UNKNOWN, never assumed open (P8)", () => {
    expect(slotStatus({ thursday: [NULL_DAY] }, "thursday", 12).status).toBe("UNKNOWN");
  });

  it("a missing weekday and an empty hours object are UNKNOWN (P23 /search hits)", () => {
    expect(slotStatus({ friday: [{ opens: "T08:00:00", closes: "T18:00:00", closed: false }] }, "thursday", 12).status).toBe("UNKNOWN");
    const bagock = byName(searchHits, "BAGOCK Fried Chicken & Doughnuts");
    expect(slotStatus(bagock.properties?.hours, "thursday", 12).status).toBe("UNKNOWN");
    expect(slotStatus(undefined, "thursday", 12).status).toBe("UNKNOWN");
  });

  it("closed:true marks the whole day CLOSED", () => {
    const s = slotStatus({ saturday: [{ opens: null, closes: null, closed: true }] }, "saturday", 12);
    expect(s.status).toBe("CLOSED");
    expect(s.dayClosed).toBe(true);
  });

  it("overnight wrap 18:00–04:00 covers 23:00 the same day (Baby's All Right, P8)", () => {
    expect(slotStatus(BABYS_ALL_RIGHT, "thursday", 23).status).toBe("OPEN");
    expect(slotStatus(BABYS_ALL_RIGHT, "thursday", 17).status).toBe("CLOSED");
  });

  it("overnight wrap carries into the next morning until close", () => {
    expect(slotStatus(BABYS_ALL_RIGHT, "friday", 2).status).toBe("OPEN");
    expect(slotStatus(BABYS_ALL_RIGHT, "friday", 2).detail).toContain("overnight from Thu");
    expect(slotStatus(BABYS_ALL_RIGHT, "friday", 5).status).toBe("CLOSED");
    // Sunday 02:00 has no Saturday hours to wrap from and no Sunday hours: unknown
    expect(slotStatus(BABYS_ALL_RIGHT, "sunday", 2).status).toBe("UNKNOWN");
  });

  it("split service (lunch + dinner) is closed between the intervals", () => {
    const h: WeekHours = { thursday: [{ opens: "T11:00:00", closes: "T14:30:00", closed: false }, { opens: "T17:30:00", closes: "T22:00:00", closed: false }] };
    expect(slotStatus(h, "thursday", 12).status).toBe("OPEN");
    expect(slotStatus(h, "thursday", 15).status).toBe("CLOSED");
    expect(slotStatus(h, "thursday", 19).status).toBe("OPEN");
  });

  it("00:00–00:00 is read as open 24 hours", () => {
    expect(slotStatus({ thursday: [{ opens: "T00:00:00", closes: "T00:00:00", closed: false }] }, "thursday", 3).status).toBe("OPEN");
  });

  it("re-slot moves Dun-Well to the latest free hour that day it is open (18:00 → 15:00)", () => {
    const dw = byName(recovery14, "Dun-Well Doughnuts");
    expect(reslotHour(dw.properties?.hours, "thursday", [10, 15, 18])).toBe(15);
  });

  it("unknown hours are never re-slotted", () => {
    expect(reslotHour({ thursday: [NULL_DAY] }, "thursday", [10, 15, 18])).toBeNull();
  });
});

describe("R-ALC: exact deny list + token screen (in recovery)", () => {
  it("catches every captured candidate that carries one of the 14 exclusion tags (recovery-OFF pool)", () => {
    const carriers = recoveryOff.filter((e) => tagIds(e).some((t) => (ALCOHOL_EXCLUDE_14 as readonly string[]).includes(t)));
    expect(carriers.length).toBeGreaterThan(10);
    for (const e of carriers) expect(alcoholScreen(e).verdict, e.name).toBe("REFUSE");
  });

  it("the 14-tag server-side exclusion left no excluded tag in the captured pool", () => {
    for (const e of recovery14) expect(tagIds(e).filter((t) => (ALCOHOL_EXCLUDE_14 as readonly string[]).includes(t)), e.name).toEqual([]);
  });

  it("strikes what the 14 tags missed: Hungry Ghost Coffee (specialty_alcoholic) — P19 leak", () => {
    const r = alcoholScreen(byName(recovery14, "Hungry Ghost Coffee"));
    expect(r.verdict).toBe("REFUSE");
    expect(r.hits.map((h) => h.value)).toContain("urn:tag:beverage_offering:qloo:specialty_alcoholic");
  });

  it("strikes The Meat Hook (craft_beer) — P19 leak", () => {
    const r = alcoholScreen(byName(recovery14, "The Meat Hook"));
    expect(r.verdict).toBe("REFUSE");
    expect(r.hits.map((h) => h.value)).toContain("urn:tag:beverage_offering:qloo:craft_beer");
  });

  it("sends bar_seating-only venues to clinician REVIEW, not PASS (Mission Sandwich Social, P19)", () => {
    const r = alcoholScreen(byName(recovery14, "Mission Sandwich Social"));
    expect(r.verdict).toBe("REVIEW");
    expect(r.hits).toEqual([{ source: "tag", value: "urn:tag:amenity:qloo:bar_seating", verdict: "REVIEW" }]);
  });

  it("D9 bench false positives: topping_bar PASSes; bar_stools / happy_hour / ok_to_order_just_drinks go to REVIEW; bar_service still REFUSEs", () => {
    expect(alcoholScreen(place({ name: "16 Handles", tags: withTags("urn:tag:amenity:qloo:topping_bar") })).verdict).toBe("PASS");
    expect(alcoholScreen(place({ name: "ROKA", tags: withTags("urn:tag:amenity:qloo:bar_stools") })).verdict).toBe("REVIEW");
    expect(alcoholScreen(place({ name: "Dunkin'", tags: withTags("urn:tag:offerings:place:happy_hour", "urn:tag:offerings:place:ok_to_order_just_drinks") })).verdict).toBe("REVIEW");
    expect(alcoholScreen(place({ tags: withTags("urn:tag:amenity:qloo:bar_service") })).verdict).toBe("REFUSE");
    expect(alcoholScreen(place({ tags: withTags("urn:tag:offerings:place:happy_hour_drinks") })).verdict).toBe("REFUSE");
    expect(alcoholScreen(place({ tags: withTags("urn:tag:amenity:qloo:bar_wine_list") })).verdict).toBe("REFUSE");
  });

  it("does not false-positive on P10's substring traps: independent_publishing, barbecue_grill, espresso_bar, book_publisher", () => {
    const e = place({ name: "Desert Island", tags: withTags("urn:tag:interests:qloo:independent_publishing", "urn:tag:amenities:place:barbecue_grill", "urn:tag:category:place:espresso_bar", "urn:tag:category:place:book_publisher", "urn:tag:nearby_attraction:qloo:brooklyn_brewery") });
    expect(alcoholScreen(e)).toEqual({ verdict: "PASS", hits: [] });
  });

  it("treats non-alcoholic offerings as allowed (specialty_non_alcoholic contains 'alcoholic')", () => {
    expect(alcoholScreen(place({ tags: withTags("urn:tag:beverage_offering:qloo:specialty_non_alcoholic", "urn:tag:beverage_offering:qloo:soft_drinks") })).verdict).toBe("PASS");
  });

  it("screens venue names by token with an allow list: 'Tea Bar' passes, 'Bar Laika' is refused", () => {
    expect(alcoholScreen(place({ name: "Tea Bar", tags: [] })).verdict).toBe("PASS");
    expect(alcoholScreen(place({ name: "Milk Bar", tags: [] })).verdict).toBe("PASS");
    expect(alcoholScreen(place({ name: "Bar Laika", tags: [] })).verdict).toBe("REFUSE");
    expect(alcoholScreen(place({ name: "Kings County Distillery", tags: [] })).verdict).toBe("REFUSE");
    expect(alcoholScreen(place({ name: "Barbecue Joint", tags: [] })).verdict).toBe("PASS");
  });

  it("an ambiguous sustainable_bar event venue goes to REVIEW (Dobbin St, P10)", () => {
    expect(alcoholScreen(place({ name: "Dobbin St", tags: withTags("urn:tag:amenity:qloo:sustainable_bar") })).verdict).toBe("REVIEW");
  });

  it("an unlisted alcohol tag is still caught by its token (wine_flights), audience-only signals go to REVIEW", () => {
    expect(alcoholScreen(place({ tags: withTags("urn:tag:menu_highlight:qloo:wine_flights") })).verdict).toBe("REFUSE");
    expect(alcoholScreen(place({ tags: withTags("urn:tag:customer_identity:qloo:cocktail_enthusiasts") })).verdict).toBe("REVIEW");
  });

  it("reads /search's tag_id field the same as /v2/insights' id field (P23)", () => {
    const hit = { name: "Somewhere", tags: [{ tag_id: "urn:tag:beverage_offering:qloo:craft_beer" }] } as QlooEntity;
    expect(alcoholScreen(hit).verdict).toBe("REFUSE");
  });
});

describe("R-KIND: behavioural-activation categories only", () => {
  it("refuses butchers even though Qloo also tags them 'restaurant' (Marlow & Daughters, The Meat Hook)", () => {
    expect(activityKind(byName(recovery14, "Marlow & Daughters")).ok).toBe(false);
    expect(activityKind(byName(recovery14, "The Meat Hook")).ok).toBe(false);
  });

  it("admits cafés, bakeries and cuisine restaurants; refuses tattoo shops and a bare 'restaurant' tag", () => {
    expect(activityKind(byName(recovery14, "Dun-Well Doughnuts")).ok).toBe(true);
    expect(activityKind(byName(recovery14, "Thip Osha")).ok).toBe(true);
    expect(activityKind(place({ tags: withTags("urn:tag:category:place:tattoo_shop", "urn:tag:category:place:art_studio") })).ok).toBe(false);
    expect(activityKind(place({ tags: withTags("urn:tag:category:place:restaurant") })).ok).toBe(false);
    expect(activityKind(place({ tags: withTags("urn:tag:category:place:local_history_museum") })).ok).toBe(true);
  });

  it("refuses a drinking-establishment category even beside 'cafe' (B5 bench: TeKu Tavern + Café), for every case", () => {
    const teku = place({ name: "TeKu Tavern + Café", tags: withTags("urn:tag:category:place:cafe", "urn:tag:category:place:bar", "urn:tag:category:place:beer_hall", "urn:tag:category:place:cider_bar") });
    const k = activityKind(teku);
    expect(k.ok).toBe(false);
    expect(k.categories[0]).toBe("bar");
    expect(activityKind(place({ tags: withTags("urn:tag:category:place:chicken_restaurant", "urn:tag:category:place:sports_bar") })).ok).toBe(false);
    expect(activityKind(place({ tags: withTags("urn:tag:category:place:brunch_restaurant", "urn:tag:category:place:brewery") })).ok).toBe(false);
    // not drinking: espresso/poke bars, and a `genre:` bar tag on its own is not a category
    expect(activityKind(place({ tags: withTags("urn:tag:category:place:coffee_shop", "urn:tag:category:place:espresso_bar") })).ok).toBe(true);
    expect(activityKind(place({ tags: withTags("urn:tag:category:place:japanese_restaurant", "urn:tag:category:place:poke_bar") })).ok).toBe(true);
    expect(activityKind(place({ tags: withTags("urn:tag:category:place:cafe", "urn:tag:genre:place:restaurant:bar") })).ok).toBe(true);
    // the refusal names the drinking category, not merely the first tag
    const v = verifyCard(teku, { kind: "outing", constraints: MAYA, slot: thu(15) });
    expect(v.reasons.find((r) => r.rule === "R-KIND")?.detail).toBe("not an activity: bar");
  });

  it("refuses bar-and-grill, night clubs, lounges and izakayas for every case; barbecue is not a bar (QA round 1: Dokebi Bar and Grill)", () => {
    // live week 1, not in recovery: placed Sat 18:00 (tags from spike/dx-repro.json F2)
    const dokebi = place({ name: "Dokebi Bar and Grill", tags: withTags("urn:tag:category:place:korean_restaurant", "urn:tag:category:place:bar_grill", "urn:tag:offerings:place:hard_liquor", "urn:tag:offerings:place:alcohol") });
    const v = verifyCard(dokebi, { kind: "outing", constraints: MAYA, slot: thu(15) });
    expect(MAYA.inRecovery).toBe(false);
    expect(v.verdict).toBe("REFUSE");
    expect(v.reasons.find((r) => r.rule === "R-KIND")?.detail).toBe("not an activity: bar_grill");
    for (const slug of ["gastropub", "night_club", "lounge", "cocktail_lounge", "hookah_bar", "izakaya", "sake_bar", "karaoke_bar", "bar_and_grill"])
      expect(activityKind(place({ tags: withTags("urn:tag:category:place:japanese_restaurant", `urn:tag:category:place:${slug}`) })).ok, slug).toBe(false);
    expect(activityKind(place({ tags: withTags("urn:tag:category:place:barbecue_restaurant") })).ok).toBe(true);
  });
});

describe("verifyCard: the whole rule set against the case row", () => {
  it("Dun-Well at Thu 18:00 is refused by R-OPEN only; at 15:00 it passes every rule", () => {
    const dw = byName(recovery14, "Dun-Well Doughnuts");
    const at18 = verifyCard(dw, { kind: "outing", constraints: MAYA_RECOVERY, slot: thu(18) });
    expect(at18.verdict).toBe("REFUSE");
    expect(at18.reasons.map((r) => r.rule)).toEqual(["R-OPEN"]);
    expect(verifyCard(dw, { kind: "outing", constraints: MAYA_RECOVERY, slot: thu(15) }).verdict).toBe("PASS");
  });

  it("I3: in recovery, no captured candidate with an alcohol signal passes; REVIEW is never PASS", () => {
    for (const e of [...recoveryOff, ...recovery14]) {
      const r = verifyCard(e, { kind: "outing", constraints: MAYA_RECOVERY, slot: thu(12) });
      if (alcoholScreen(e).verdict === "REFUSE") expect(r.verdict, e.name).toBe("REFUSE");
      if (alcoholScreen(e).verdict === "REVIEW") expect(r.verdict, e.name).not.toBe("PASS");
    }
  });

  it("R-ALC only applies in recovery, and the bench ablation can switch the screen off", () => {
    const commodore = byName(recoveryOff, "The Commodore");
    const off = verifyCard(commodore, { kind: "outing", constraints: MAYA, slot: thu(19) });
    expect(off.checks.find((c) => c.rule === "R-ALC")?.verdict).toBe("PASS");
    const ablated = verifyCard(commodore, { kind: "outing", constraints: MAYA_RECOVERY, slot: thu(19), alcoholScreen: false });
    expect(ablated.checks.find((c) => c.rule === "R-ALC")?.detail).toBe("screen off (ablation)");
    expect(verifyCard(commodore, { kind: "outing", constraints: MAYA_RECOVERY, slot: thu(19) }).reasons.map((r) => r.rule)).toContain("R-ALC");
  });

  it("R-NEAR refuses beyond the case radius and when distance is missing", () => {
    expect(verifyCard(place({ query: { distance: 1600 } }), { kind: "outing", constraints: MAYA, slot: thu(12) }).reasons[0]).toMatchObject({ rule: "R-NEAR", detail: "1600 m > 1500 m" });
    expect(verifyCard(place({ query: {} }), { kind: "outing", constraints: MAYA, slot: thu(12) }).reasons[0]).toMatchObject({ rule: "R-NEAR", detail: "distance unknown" });
  });

  it("R-PRICE refuses a price level over the case cap and passes when Qloo has none", () => {
    const pricey = place({ properties: { hours: place({}).properties!.hours, price_level: 3 } });
    expect(verifyCard(pricey, { kind: "outing", constraints: MAYA, slot: thu(12) }).reasons.map((r) => r.rule)).toEqual(["R-PRICE"]);
    expect(verifyCard(place({}), { kind: "outing", constraints: MAYA, slot: thu(12) }).verdict).toBe("PASS");
  });

  it("R-QUIET and R-ACCESS require the tag whenever the case flag is set", () => {
    const c = { ...MAYA, needQuiet: true, needWheelchair: true };
    expect(verifyCard(place({}), { kind: "outing", constraints: c, slot: thu(12) }).reasons.map((r) => r.rule)).toEqual(["R-QUIET", "R-ACCESS"]);
    const ok = place({ tags: withTags("urn:tag:category:place:cafe", TAG_QUIET, TAG_WHEELCHAIR) });
    expect(verifyCard(ok, { kind: "outing", constraints: c, slot: thu(12) }).verdict).toBe("PASS");
  });

  it("R-HIST refuses an entity the patient rated ≤3; R-ID refuses a missing or unseen entity_id", () => {
    expect(verifyCard(place({}), { kind: "outing", constraints: MAYA, slot: thu(12), lowRated: new Set(["X"]) }).reasons.map((r) => r.rule)).toEqual(["R-HIST"]);
    expect(verifyCard(place({ entity_id: "" }), { kind: "outing", constraints: MAYA, slot: thu(12) }).reasons[0].rule).toBe("R-ID");
    expect(verifyCard(place({}), { kind: "outing", constraints: MAYA, slot: thu(12), seenIds: new Set(["other"]) }).reasons[0]).toMatchObject({ rule: "R-ID", detail: "entity_id not returned by Qloo in this run" });
  });

  it("a permanently closed venue is refused even with matching hours", () => {
    const shut = place({ properties: { ...place({}).properties, is_closed: true } });
    expect(verifyCard(shut, { kind: "outing", constraints: MAYA, slot: thu(12) }).reasons[0]).toMatchObject({ rule: "R-OPEN", detail: "permanently closed in Qloo" });
  });

  it("REFUSE outranks REVIEW when both fire", () => {
    const e = place({ query: { distance: 9000 }, tags: withTags("urn:tag:category:place:cafe", "urn:tag:amenity:qloo:bar_seating") });
    const r = verifyCard(e, { kind: "outing", constraints: MAYA_RECOVERY, slot: thu(12) });
    expect(r.verdict).toBe("REFUSE");
    expect(r.reasons.map((x) => `${x.rule}:${x.verdict}`)).toEqual(["R-NEAR:REFUSE", "R-ALC:REVIEW"]);
  });

  it("at-home cards are checked for R-ID and R-HIST only (captured Lucy Dacus passes)", () => {
    const dacus = byName(captured("athome-artist"), "Lucy Dacus");
    const r = verifyCard(dacus, { kind: "home", constraints: MAYA_RECOVERY });
    expect(r.verdict).toBe("PASS");
    expect(r.checks.map((c) => c.rule)).toEqual(["R-ID", "R-HIST"]);
  });
});

describe("explainability split (the why line)", () => {
  it("returns per-love scores sorted high → low from the captured response", () => {
    const split = explainSplit(byName(recovery14, "Dun-Well Doughnuts"));
    expect(split).toHaveLength(2);
    expect(split[0].entity_id).toBe("AFBC71A7-9439-4AB0-AB68-D14B11AAF836"); // Phoebe Bridgers
    expect(split[0].score).toBeGreaterThan(split[1].score);
    expect(split[0].score + split[1].score).toBeCloseTo(1, 5);
  });

  it("returns [] when explainability is absent", () => {
    expect(explainSplit(place({ query: {} }))).toEqual([]);
  });
});
