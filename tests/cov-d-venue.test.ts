import { afterEach, describe, expect, it, vi } from "vitest";
import type { QlooClient, QlooEntity } from "../lib/qloo";
import { gradeEntity, matchHit, namesMatch, nominatim, NOMINATIM_UA, verifyVenue, type Geocoder } from "../lib/venue";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const ent = (o: Partial<QlooEntity> & { name: string }): QlooEntity => ({ entity_id: "e1", ...o });
const qloo = (o: { entities?: unknown; search?: unknown }) =>
  ({ entities: vi.fn(async () => o.entities), search: vi.fn(async () => o.search) }) as unknown as QlooClient & { entities: ReturnType<typeof vi.fn>; search: ReturnType<typeof vi.fn> };
const noGeo: Geocoder = async () => {
  throw new Error("geocoder must not be called");
};
const wed = { monday: [], wednesday: [{ opens: "T08:00:00", closes: "T18:00:00" }] };

describe("cov-d venue", () => {
  it.each([
    ["", "Blue Door", false],
    ["Blue Door", "", false],
    ["Blue Door", "blue door", true],
    ["Café", "Cafe", true], // equal after accent stripping
    ["Zoe's", "The Zoes Kitchen", false], // single token under 5 chars
    ["Zoe's Kitchen", "The Zoes Kitchen Bar", true], // contained
    ["a b", "c d", false], // distinctive tokens all stop? no: tokens a,b vs c,d -> no hit
    ["The Cafe", "Restaurant", false], // short has zero distinctive tokens
    ["Joe", "Joe Grill House", false], // single short token (<5) with no containment
    ["Brooklyn Bagel", "Bagel Brooklyn Cafe", true],
  ])("namesMatch(%j, %j) = %s", (a, b, want) => {
    expect(namesMatch(a, b)).toBe(want);
  });

  it("matchHit reads latitude/longitude, skips entities without a point, picks the closest", () => {
    const p = { lat: 40, lon: -74 };
    const hits = [
      ent({ entity_id: "nopoint", name: "Blue Door" }),
      ent({ entity_id: "strs", name: "Blue Door", location: { lat: "x", lon: "y" } as never }),
      ent({ entity_id: "far", name: "Blue Door", location: { latitude: 40.1, longitude: -74 } as never }),
      ent({ entity_id: "near2", name: "Blue Door", location: { latitude: 40.002, longitude: -74 } as never }),
      ent({ entity_id: "near1", name: "Blue Door", location: { lat: 40.001, lon: -74 } }),
      ent({ entity_id: "wrongname", name: "Other", location: { lat: 40, lon: -74 } }),
    ];
    const m = matchHit("Blue Door", p, hits);
    expect(m?.e.entity_id).toBe("near1");
    expect(matchHit("Blue Door", p, [])).toBeNull();
  });

  it("gradeEntity: permanently closed overrides hours; otherwise hours and alcohol are graded", () => {
    const e = ent({ name: "Tea", properties: { hours: wed, is_closed: true }, tags: [{ id: "urn:tag:genre:place:bar" }] });
    expect(gradeEntity(e, "wednesday", 10).slot).toEqual({ status: "CLOSED", hours: "Wed 08:00–18:00", detail: "permanently closed in Qloo" });
    const open = gradeEntity(ent({ name: "Tea", properties: { hours: wed } }), "wednesday", 10);
    expect(open.slot.status).toBe("OPEN");
    expect(open.alcohol).toEqual({ verdict: "PASS", hits: [] });
  });

  it("verifyVenue rejects an invalid day", async () => {
    await expect(verifyVenue(qloo({}), noGeo, { name: "x", day: "funday" as never, hour: 1 })).rejects.toThrow("invalid day");
  });

  describe("entity mode", () => {
    it("found: graded, distance from origin, string address kept", async () => {
      const e = ent({ entity_id: "E", name: "Tea", properties: { hours: wed, address: "1 Main St" }, location: { lat: 40, lon: -74 } });
      const v = await verifyVenue(qloo({ entities: { results: [e] } }), noGeo, { name: "Tea", entity_id: "E", day: "wednesday", hour: 10, origin: { lat: 40.001, lon: -74 } });
      expect(v).toMatchObject({ mode: "entity", verifiable: true, candidates: 1, match: { entity_id: "E", address: "1 Main St", distance_m: null }, slot: { status: "OPEN" } });
      expect(v.distance_from_origin_m).toBeGreaterThan(100);
    });
    it("found without location/origin/address: nulls", async () => {
      const e = ent({ entity_id: "E", name: "Tea", properties: { address: 5 as never } });
      const v = await verifyVenue(qloo({ entities: { results: [e] } }), noGeo, { name: "Tea", entity_id: "E", day: "wednesday", hour: 10 });
      expect(v.match?.address).toBeNull();
      expect(v.distance_from_origin_m).toBeNull();
    });
    it("origin given but entity has no point: null distance", async () => {
      const e = ent({ entity_id: "E", name: "Tea" });
      const v = await verifyVenue(qloo({ entities: { results: [e] } }), noGeo, { name: "Tea", entity_id: "E", day: "monday", hour: 10, origin: { lat: 1, lon: 1 } });
      expect(v.distance_from_origin_m).toBeNull();
    });
    it("not found / missing results: unverifiable with candidate count", async () => {
      const other = ent({ entity_id: "Z", name: "Z" });
      expect(await verifyVenue(qloo({ entities: { results: [other] } }), noGeo, { name: "Tea", entity_id: "E", day: "monday", hour: 1 })).toMatchObject({ verifiable: false, candidates: 1, match: null });
      expect(await verifyVenue(qloo({ entities: {} }), noGeo, { name: "Tea", entity_id: "E", day: "monday", hour: 1 })).toMatchObject({ verifiable: false, candidates: 0 });
    });
  });

  describe("address mode", () => {
    const q = { name: "Blue Door", day: "wednesday" as const, hour: 10 };
    const hit = ent({ entity_id: "H", name: "Blue Door Cafe", properties: { hours: wed, address: "2 Elm" }, location: { lat: 40.001, lon: -74 } });

    it("no address and no point: no geocode, unverifiable", async () => {
      const k = qloo({});
      expect(await verifyVenue(k, noGeo, q)).toMatchObject({ mode: "address", geocode: null, verifiable: false });
      expect(k.search).not.toHaveBeenCalled();
    });
    it("geocodes the address, searches near it and returns the closest name match", async () => {
      const geo: Geocoder = vi.fn(async () => ({ lat: 40, lon: -74, display_name: "d" }));
      const k = qloo({ search: { results: [hit] } });
      const v = await verifyVenue(k, geo, { ...q, address: "2 Elm", origin: { lat: 40, lon: -74 } });
      expect(geo).toHaveBeenCalledWith("2 Elm");
      expect(k.search).toHaveBeenCalledWith("Blue Door", { types: ["urn:entity:place"], take: 20, extra: { "filter.location": "40,-74", "filter.radius": 1 } });
      expect(v).toMatchObject({ verifiable: true, candidates: 1, match: { entity_id: "H", address: "2 Elm" }, slot: { status: "OPEN" } });
      expect(v.match?.distance_m).toBeGreaterThan(0);
      expect(v.distance_from_origin_m).toBeGreaterThan(0);
    });
    it("a given point bypasses geocoding; a geocoder returning null is unverifiable", async () => {
      const k = qloo({ search: { results: [hit] } });
      const v = await verifyVenue(k, noGeo, { ...q, point: { lat: 40, lon: -74 } });
      expect(v.geocode?.display_name).toBe("(point given)");
      expect(await verifyVenue(k, async () => null, { ...q, address: "nowhere" })).toMatchObject({ geocode: null, verifiable: false });
    });
    it("no name match within range, or no results key: unverifiable but candidates counted", async () => {
      const far = ent({ entity_id: "F", name: "Blue Door", location: { lat: 41, lon: -74 } });
      const a = await verifyVenue(qloo({ search: { results: [far] } }), noGeo, { ...q, point: { lat: 40, lon: -74 } });
      expect(a).toMatchObject({ verifiable: false, candidates: 1, match: null });
      const b = await verifyVenue(qloo({ search: {} }), noGeo, { ...q, point: { lat: 40, lon: -74 } });
      expect(b).toMatchObject({ verifiable: false, candidates: 0 });
    });
    it("matched entity without an address string: address null, no origin: null distance", async () => {
      const h = ent({ entity_id: "H", name: "Blue Door", location: { lat: 40, lon: -74 } });
      const v = await verifyVenue(qloo({ search: { results: [h] } }), noGeo, { ...q, point: { lat: 40, lon: -74 } });
      expect(v.match).toMatchObject({ address: null, distance_m: 0 });
      expect(v.distance_from_origin_m).toBeNull();
    });
  });

  describe("nominatim", () => {
    const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

    it("first result only, identifying UA, urlencoded query", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
      const f = vi.fn(async () => res(200, [{ lat: "40.5", lon: "-74.5", display_name: "Somewhere" }]));
      const sleep = vi.fn(async () => {});
      const g = nominatim(f as unknown as typeof fetch, sleep);
      expect(await g("1 Main St")).toEqual({ lat: 40.5, lon: -74.5, display_name: "Somewhere" });
      const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toContain("q=1+Main+St");
      expect(url).toContain("limit=1");
      expect((init.headers as Record<string, string>)["User-Agent"]).toBe(NOMINATIM_UA);
    });

    it("throttles to one request per 1.1 s (injected sleep) and returns null on an empty result", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2031-01-01T00:00:00Z"));
      const f = vi.fn(async () => res(200, []));
      const sleep = vi.fn(async () => {});
      const g = nominatim(f as unknown as typeof fetch, sleep);
      await g("a");
      expect(sleep).not.toHaveBeenCalled();
      expect(await g("b")).toBeNull();
      expect(sleep).toHaveBeenCalledTimes(1);
      expect((sleep.mock.calls as unknown as number[][])[0]![0]).toBeGreaterThan(1000);
    });

    it("a non-2xx throws", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2032-01-01T00:00:00Z"));
      const g = nominatim((async () => res(503, {})) as unknown as typeof fetch, async () => {});
      await expect(g("x")).rejects.toThrow("Nominatim 503");
    });

    it("defaults: global fetch and the real timer-based sleep", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2033-01-01T00:00:00Z"));
      const f = vi.fn(async () => res(200, []));
      vi.stubGlobal("fetch", f);
      const g = nominatim();
      await g("a");
      const p = g("b");
      await vi.advanceTimersByTimeAsync(1200);
      expect(await p).toBeNull();
      expect(f).toHaveBeenCalledTimes(2);
    });
  });
});
