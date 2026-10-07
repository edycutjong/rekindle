#!/usr/bin/env python3
"""Deterministic seed resolver. Python 3 stdlib only.

The 20 bench profiles are FICTIONAL input profiles (loves + constraints). `--resolve` resolves every love live against
Qloo once — /search pinned to an entity type, or /v2/tags for food/activity loves — and writes:

  fixtures/profiles.csv   one row per love (case, love columns, then slug/locality/lon/lat/type/name)
  fixtures/profiles.json  the same profiles, grouped, for POST /api/cases/seed/:slug

A love that does not resolve fails the run loudly (no guessed IDs). Output is a pure function of the Qloo responses
(no timestamps), so re-running against unchanged Qloo data produces byte-identical files. Seeds are inputs only: every
plan is generated live by the agent (R10).

  QLOO_API_KEY=... python3 scripts/seed.py --resolve [--out fixtures]
  python3 scripts/seed.py --check            # validate the committed files against the table below (no network)
"""
import argparse
import csv
import io
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = "https://hackathon.api.qloo.com"

# (slug, label, locality, lon, lat, energy, in_recovery, need_quiet, need_wheelchair, loves)
# love = (text as the clinician typed it, Qloo query, kind) with kind in artist|tv_show|movie|book|podcast|album|tag.
# energy → radius: 1 → 1500 m, 2 → 3000 m, 3 → 5000 m. price_max = 2 (≤$$) for every profile.
# Maya's in_recovery is False here: the demo toggles it live; the bench sets it per arm.
PROFILES = [
    ("maya", "Maya", "Williamsburg, Brooklyn", -73.9571, 40.7081, 1, False, False, False,
     [("Phoebe Bridgers", "Phoebe Bridgers", "artist"), ("Fleabag", "Fleabag", "tv_show"), ("ramen", "ramen", "tag")]),
    ("theo", "Theo", "Park Slope, Brooklyn", -73.9776, 40.6710, 2, True, False, False,
     [("Radiohead", "Radiohead", "artist"), ("The Bear", "The Bear", "tv_show"), ("coffee", "coffee", "tag")]),
    ("ana", "Ana", "Lower East Side, Manhattan", -73.9880, 40.7150, 3, False, False, False,
     [("Bad Bunny", "Bad Bunny", "artist"), ("Jane the Virgin", "Jane the Virgin", "tv_show"), ("tacos", "tacos", "tag")]),
    ("sam", "Sam", "Astoria, Queens", -73.9235, 40.7644, 2, False, True, True,
     [("Studio Ghibli films", "Spirited Away", "movie"), ("Ursula K. Le Guin", "The Left Hand of Darkness", "book"), ("board games", "board game", "tag")]),
    ("priya", "Priya", "Harlem, Manhattan", -73.9465, 40.8116, 1, True, False, False,
     [("Hamilton (cast album)", "Hamilton", "album"), ("Michelle Obama, Becoming", "Becoming", "book"), ("jazz", "jazz", "tag")]),
    ("jo", "Jo", "Echo Park, Los Angeles", -118.2606, 34.0782, 3, True, True, False,
     [("Lana Del Rey", "Lana Del Rey", "artist"), ("Twin Peaks", "Twin Peaks", "tv_show"), ("vintage", "vintage", "tag")]),
    ("marcus", "Marcus", "Silver Lake, Los Angeles", -118.2703, 34.0869, 2, False, False, False,
     [("Kendrick Lamar", "Kendrick Lamar", "artist"), ("Atlanta (TV)", "Atlanta", "tv_show"), ("basketball", "basketball", "tag")]),
    ("lena", "Lena", "Santa Monica, Los Angeles", -118.4912, 34.0195, 3, False, False, True,
     [("Taylor Swift", "Taylor Swift", "artist"), ("Gilmore Girls", "Gilmore Girls", "tv_show"), ("bookstores", "bookstore", "tag")]),
    ("ruth", "Ruth", "Pasadena, Los Angeles", -118.1445, 34.1478, 1, False, True, False,
     [("Joni Mitchell", "Joni Mitchell", "artist"), ("The Great British Bake Off", "The Great British Bake Off", "tv_show"), ("gardens", "garden", "tag")]),
    ("dev", "Dev", "Mission District, San Francisco", -122.4194, 37.7599, 2, True, False, False,
     [("Bon Iver", "Bon Iver", "artist"), ("Severance", "Severance", "tv_show"), ("hiking", "hiking", "tag")]),
    ("kim", "Kim", "Inner Sunset, San Francisco", -122.4663, 37.7602, 3, False, False, False,
     [("BTS", "BTS", "artist"), ("Crash Landing on You", "Crash Landing on You", "tv_show"), ("Korean food", "korean", "tag")]),
    ("omar", "Omar", "Wicker Park, Chicago", -87.6776, 41.9088, 1, True, True, False,
     [("Chance the Rapper", "Chance the Rapper", "artist"), ("The Office", "The Office", "tv_show"), ("museums", "museum", "tag")]),
    ("grace", "Grace", "Hyde Park, Chicago", -87.5936, 41.7943, 2, False, False, True,
     [("Beyoncé", "Beyoncé", "artist"), ("Insecure", "Insecure", "tv_show"), ("gospel", "gospel", "tag")]),
    ("leo", "Leo", "Logan Square, Chicago", -87.7076, 41.9234, 3, True, False, False,
     [("Arctic Monkeys", "Arctic Monkeys", "artist"), ("Peaky Blinders", "Peaky Blinders", "tv_show"), ("vinyl", "record store", "tag")]),
    ("hana", "Hana", "Capitol Hill, Seattle", -122.3207, 47.6253, 1, True, True, False,
     [("Mitski", "Mitski", "artist"), ("Normal People", "Normal People", "tv_show"), ("tea", "tea", "tag")]),
    ("ben", "Ben", "Fremont, Seattle", -122.3496, 47.6510, 3, False, False, False,
     [("Pearl Jam", "Pearl Jam", "artist"), ("Twin Peaks", "Twin Peaks", "tv_show"), ("coffee", "coffee", "tag")]),
    ("ivy", "Ivy", "Williamsburg, Brooklyn", -73.9615, 40.7140, 1, True, False, True,
     [("Fleetwood Mac", "Fleetwood Mac", "artist"), ("Schitt's Creek", "Schitt's Creek", "tv_show"), ("pottery", "pottery", "tag")]),
    ("nate", "Nate", "Bushwick, Brooklyn", -73.9196, 40.6944, 2, True, False, False,
     [("Frank Ocean", "Frank Ocean", "artist"), ("Euphoria", "Euphoria", "tv_show"), ("art galleries", "art gallery", "tag")]),
    ("ruby", "Ruby", "Des Moines, IA (thin-coverage control)", -93.6091, 41.5868, 2, False, False, False,
     [("Kacey Musgraves", "Kacey Musgraves", "artist"), ("Parks and Recreation", "Parks and Recreation", "tv_show"), ("bakeries", "bakery", "tag")]),
    ("cal", "Cal", "Bozeman, MT (thin-coverage control)", -111.0429, 45.6770, 1, False, True, False,
     [("Zach Bryan", "Zach Bryan", "artist"), ("Yellowstone", "Yellowstone", "tv_show"), ("fly fishing", "fly fishing", "tag")]),
]

RADIUS = {1: 1500, 2: 3000, 3: 5000}
PRICE_MAX = 2
CSV_COLUMNS = ["label", "point_wkt", "radius_m", "energy", "price_max", "in_recovery", "need_quiet", "need_wheelchair",
               "love_text", "qloo_id", "qloo_kind", "slug", "locality", "lon", "lat", "entity_type", "resolved_name"]


def qloo_get(path, params, key, attempts=3):
    url = f"{BASE}{path}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"X-Api-Key": key, "Accept": "application/json", "User-Agent": "rekindle-seed/0.1"})
    for i in range(attempts):
        try:
            with urllib.request.urlopen(req, timeout=15) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code not in (429, 500, 502, 503, 504) or i == attempts - 1:
                raise
        except urllib.error.URLError:
            if i == attempts - 1:
                raise
        time.sleep(1.0 + i)


def pick_tag(tags):
    """Same preference as lib/resolve.ts: place-genre tags drive place ranking (P14), then any place tag, then the first."""
    ids = [t.get("id") or t.get("tag_id") for t in tags if t.get("id") or t.get("tag_id")]
    for pred in (lambda t: t.startswith("urn:tag:genre:place:restaurant:"), lambda t: ":place" in t, lambda t: True):
        for t in ids:
            if pred(t):
                return t
    return None


def resolve(text, query, kind, key):
    if kind == "tag":
        body = qloo_get("/v2/tags", {"filter.query": query, "take": 20}, key)
        tags = (body.get("results") or {}).get("tags") or []
        tid = pick_tag(tags)
        if not tid:
            raise SystemExit(f'FAIL: "{text}" (query "{query}") did not resolve to a Qloo tag')
        name = next((t.get("name") for t in tags if (t.get("id") or t.get("tag_id")) == tid), query)
        return {"text": text, "qloo_id": tid, "qloo_kind": "tag", "name": name or query}
    etype = f"urn:entity:{kind}"
    body = qloo_get("/search", {"query": query, "types": etype, "take": 3}, key)
    hits = body.get("results") or []
    if not hits:
        raise SystemExit(f'FAIL: "{text}" (query "{query}") did not resolve in Qloo as {etype}')
    h = hits[0]
    return {"text": text, "qloo_id": h["entity_id"], "qloo_kind": "entity", "entity_type": etype, "name": h.get("name", query)}


def profile_record(p, loves):
    slug, label, locality, lon, lat, energy, rec, quiet, wheel, _ = p
    return {"slug": slug, "label": label, "locality": locality, "lon": lon, "lat": lat, "radius_m": RADIUS[energy],
            "energy": energy, "price_max": PRICE_MAX, "in_recovery": rec, "need_quiet": quiet, "need_wheelchair": wheel,
            "loves": loves}


def to_csv(records):
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=CSV_COLUMNS, lineterminator="\n")
    w.writeheader()
    for r in records:
        for l in r["loves"]:
            w.writerow({"label": r["label"], "point_wkt": f"POINT({r['lon']} {r['lat']})", "radius_m": r["radius_m"],
                        "energy": r["energy"], "price_max": r["price_max"], "in_recovery": str(r["in_recovery"]).lower(),
                        "need_quiet": str(r["need_quiet"]).lower(), "need_wheelchair": str(r["need_wheelchair"]).lower(),
                        "love_text": l["text"], "qloo_id": l["qloo_id"], "qloo_kind": l["qloo_kind"], "slug": r["slug"],
                        "locality": r["locality"], "lon": r["lon"], "lat": r["lat"], "entity_type": l.get("entity_type", ""),
                        "resolved_name": l.get("name", "")})
    return buf.getvalue()


def check(out):
    """Offline: the committed files match the table (labels, constraints, radius rule, love texts) and each other."""
    data = json.load(open(os.path.join(out, "profiles.json")))["profiles"]
    errors = []
    if len(data) != len(PROFILES):
        errors.append(f"expected {len(PROFILES)} profiles, found {len(data)}")
    for p, d in zip(PROFILES, data):
        exp = profile_record(p, d["loves"])
        for k in ("slug", "label", "lon", "lat", "radius_m", "energy", "price_max", "in_recovery", "need_quiet", "need_wheelchair"):
            if exp[k] != d[k]:
                errors.append(f"{p[0]}: {k} {d[k]!r} != {exp[k]!r}")
        if [l[0] for l in p[9]] != [l["text"] for l in d["loves"]]:
            errors.append(f"{p[0]}: love texts differ")
        for l in d["loves"]:
            if not l.get("qloo_id"):
                errors.append(f"{p[0]}: unresolved love {l['text']}")
    if to_csv(data) != open(os.path.join(out, "profiles.csv")).read():
        errors.append("profiles.csv is not the CSV form of profiles.json")
    counts = {"recovery": sum(p[6] for p in PROFILES), "quiet": sum(p[7] for p in PROFILES), "wheelchair": sum(p[8] for p in PROFILES)}
    for e in errors:
        print("FAIL", e)
    print(f"profiles {len(data)} · loves {sum(len(d['loves']) for d in data)} · in_recovery {counts['recovery']} (Maya toggled live) · quiet {counts['quiet']} · wheelchair {counts['wheelchair']} · {'OK' if not errors else 'FAILED'}")
    return 0 if not errors else 1


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--resolve", action="store_true", help="resolve every love live against Qloo and write the fixtures")
    ap.add_argument("--check", action="store_true", help="validate the committed fixtures offline")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "fixtures"))
    a = ap.parse_args()
    if a.check:
        return check(a.out)
    if not a.resolve:
        ap.print_help()
        return 2
    key = os.environ.get("QLOO_API_KEY")
    if not key:
        raise SystemExit("QLOO_API_KEY is not set")
    records, calls = [], 0
    for p in PROFILES:
        loves = []
        for text, query, kind in p[9]:
            loves.append(resolve(text, query, kind, key))
            calls += 1
        records.append(profile_record(p, loves))
        print(f"{p[1]:<6} " + " | ".join(f"{l['text']} → {l.get('name')} ({l['qloo_id']})" for l in loves))
    os.makedirs(a.out, exist_ok=True)
    with open(os.path.join(a.out, "profiles.json"), "w") as f:
        json.dump({"fictional": True, "source": "scripts/seed.py --resolve", "profiles": records}, f, indent=2, ensure_ascii=False)
        f.write("\n")
    with open(os.path.join(a.out, "profiles.csv"), "w") as f:
        f.write(to_csv(records))
    print(f"resolved {sum(len(r['loves']) for r in records)} loves for {len(records)} profiles with {calls} Qloo calls → {a.out}/profiles.csv, profiles.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
