import { describe, expect, it } from "vitest";
import type { QlooEntity } from "../lib/qloo";
import { parseClock, slotStatus, tagIds, verifyCard, type CaseConstraints } from "../lib/verify";

const C: CaseConstraints = { maxMeters: 1000, priceMax: 2, inRecovery: false, needQuiet: false, needWheelchair: false };
const base = (o: Partial<QlooEntity> = {}): QlooEntity => ({ entity_id: "e", name: "Place", query: { distance: 10 }, ...o });

describe("cov-d verify", () => {
  it("tagIds: missing tags -> [], id or tag_id used, both missing dropped", () => {
    expect(tagIds({})).toEqual([]);
    expect(tagIds({ tags: [{ id: "a" }, { tag_id: "b" }, {}, { id: "a", tag_id: "z" }] })).toEqual(["a", "b", "a"]);
  });

  it.each([
    ["25:00", null],
    ["24:00", 1440],
    ["08:60", null],
    ["08:59", 539],
    ["T7:05", 425],
    ["", null],
    [null, null],
    ["nope", null],
  ])("parseClock(%j) = %s", (s, want) => {
    expect(parseClock(s as string | null)).toBe(want);
  });

  it("slotStatus accepts a single (non-array) interval object and capitalised day keys", () => {
    const single = { wednesday: { opens: "T08:00:00", closes: "T18:00:00" } };
    expect(slotStatus(single, "wednesday", 10)).toMatchObject({ status: "OPEN", hoursText: "Wed 08:00–18:00" });
    const cap = { Wednesday: [{ opens: "09:00", closes: "17:00" }] } as never;
    expect(slotStatus(cap, "wednesday", 20)).toMatchObject({ status: "CLOSED", detail: "closes 17:00" });
  });

  it.each([
    ["opens later", 6, "opens 08:00"],
    ["closed earlier", 20, "closes 18:00"],
    ["NaN hour is neither before nor after", Number.NaN, "closed at NaN:NaN"],
  ])("slotStatus CLOSED detail: %s", (_n, hour, detail) => {
    expect(slotStatus({ wednesday: [{ opens: "T08:00:00", closes: "T18:00:00" }] }, "wednesday", hour)).toMatchObject({ status: "CLOSED", detail });
  });

  it("verifyCard outing without a slot refuses R-OPEN", () => {
    const r = verifyCard(base(), { kind: "outing", constraints: C });
    expect(r.checks.find((x) => x.rule === "R-OPEN")).toEqual({ rule: "R-OPEN", verdict: "REFUSE", detail: "no slot to check" });
  });

  it("verifyCard R-KIND: no place category, a hinted denied category, and a non-hinted one", () => {
    const slot = { day: "wednesday" as const, hour: 10 };
    const kind = (e: QlooEntity) => verifyCard(e, { kind: "outing", constraints: C, slot }).checks.find((x) => x.rule === "R-KIND")!;
    expect(kind(base())).toMatchObject({ verdict: "REFUSE", detail: "no place category" });
    expect(kind(base({ tags: [{ id: "urn:tag:category:place:tattoo_shop" }] })).detail).toBe("not an activity: tattoo_shop");
    expect(kind(base({ tags: [{ id: "urn:tag:category:place:zzz" }, { id: "urn:tag:category:place:yyy" }] })).detail).toBe("not an activity: zzz");
  });

  it("alcoholScreen tolerates an entity with no name (verifyCard in recovery)", () => {
    const e = base() as Partial<QlooEntity>;
    delete e.name;
    const r = verifyCard(e as QlooEntity, { kind: "outing", constraints: { ...C, inRecovery: true }, slot: { day: "wednesday", hour: 10 } });
    expect(r.checks.find((x) => x.rule === "R-ALC")).toMatchObject({ verdict: "PASS", detail: "no alcohol signal" });
  });
});
