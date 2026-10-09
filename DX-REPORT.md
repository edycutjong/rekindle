# Qloo developer-experience report

What we ran into while building Rekindle on the Qloo hackathon API, each with a command that reproduces it.

- **Created:** 2026-10-07 13:32 UTC. **Send-by for the Discord #api-help post (finding 1):** 2026-10-19.
- **Discord #api-help message:** not posted yet. A person on the team posts it; the link goes here once it exists.
- **Evidence:** every number below comes from one run of [`scripts/dx-repro.ts`](scripts/dx-repro.ts), saved as
  [`spike/dx-repro.json`](spike/dx-repro.json) (run 2026-10-07T15:05Z; findings 1–7 match the first run at 13:32Z),
  unless the line names another committed file. Finding 8 is read live from `/entities` by the same script and matches
  the capture [`fixtures/qloo_captured/2026-10-07-maya-thu-recovery-on-14tags.json`](fixtures/qloo_captured/2026-10-07-maya-thu-recovery-on-14tags.json).
- **Host:** `https://hackathon.api.qloo.com`, header `X-Api-Key`. All calls are GET.

```bash
QLOO_API_KEY=… npx tsx scripts/dx-repro.ts --out spike/dx-repro.json
```

Shared parameters used below: `$SIG` = `signal.interests.entities=AFBC71A7-9439-4AB0-AB68-D14B11AAF836,878680F2-2C8D-4D7A-8288-BEA75D38A843`
(Phoebe Bridgers and Fleabag).

| # | Finding | Severity for us | What we did |
|---|---|---|---|
| 1 | Heatmap `output.heatmap.boundary=urn:entity:locality` returns **500 System Error**, although the 400 for a bad value names it as valid | Blocked a feature | Use `urn:geohash` only |
| 2 | `filter.exclude.tags` does not remove places that serve alcohol under other tags | Safety-critical for us | A deterministic tag and name screen after Qloo |
| 3 | Opening hours: `filter.hours` is day-level only, and some `/search` hits have no hours object | Correctness | Our own slot check; missing hours = refused |
| 4 | `/search` name matching is very fuzzy for places | Correctness (bench) | Name match **and** ≤300 m, never "first hit" |
| 5 | `filter.location.query` treats "Brooklyn" as a loose area | Correctness | WKT `POINT` + `filter.location.radius` |
| 6 | Response shapes differ between endpoints | Friction | Normalise in `lib/qloo.ts` |
| 7 | Explainability lists entity signals only, never tag signals | Friction | Tag-driven picks are explained by tag membership |
| 8 | Butchers carry the generic `genre:place:restaurant` tag | Correctness | R-KIND reads the `category:place:` slugs and refuses `butcher_shop` |

## 1. Heatmap locality boundary returns 500

```bash
curl -G https://hackathon.api.qloo.com/v2/insights -H "X-Api-Key: $QLOO_API_KEY" \
  --data-urlencode "filter.type=urn:heatmap" --data-urlencode "filter.location.query=Brooklyn" \
  --data-urlencode "$SIG" --data-urlencode "output.heatmap.boundary=urn:entity:locality"
```

- **Observed:** HTTP 500, `{"errors":[{"message":"System Error"}]}`.
- The same request with `boundary=neighborhood` returns HTTP 400: `output.heatmap.boundary must be "urn:geohash" or "urn:entity:locality"`.
  The error message names `urn:entity:locality` as a valid value, but that value fails with a 500.
- With `boundary=urn:geohash` the request returns HTTP 200.
- It also failed with a 500 in our first spike (`spike/qloo-spike.json`, row P13), so it is not a one-off.
- **Expected:** a locality-level heatmap, or a 400 that says the value is not supported on this host.
- **Effect on us:** the social-outing step uses geohash-7 cells and then a place query inside the best cell (`lib/plan.ts`, `placeSocial`).

## 2. `filter.exclude.tags` does not remove every place that serves alcohol

The query is Maya's Thursday place query: `filter.type=urn:entity:place`, `$SIG`, a ramen tag signal,
`filter.location=POINT(-73.9571 40.7081)`, `filter.location.radius=1500`, `filter.hours=thursday`, `filter.price_level.max=2`, `take=25`.
The same query is sent three times, with three different exclusion sets. Our screen (`alcoholScreen` in `lib/verify.ts`) then counts the places that still carry alcohol tags.

| `filter.exclude.tags` | Places returned | Still alcohol-tagged (our screen refuses them) | Ambiguous (sent to the clinician) |
|---|---|---|---|
| none | 25 | 19 | 0 |
| 4 bar tags (`category:place:bar`, `genre:place:restaurant:bar`, `category:place:night_club`, `amenity:place:bar`) | 25 | 17 | 0 |
| our 14 alcohol tags (`ALCOHOL_EXCLUDE_14` in `lib/tags.ts`) | 25 | 2 | 2 |

- With the 14 tags excluded, these two still come back: **Hungry Ghost Coffee** (`beverage_offering:qloo:specialty_alcoholic`) and **The Meat Hook**
  (`beverage_offering:qloo:craft_beer`, `amenity:qloo:craft_beer_selection`).
- The alcohol vocabulary is spread over at least six namespaces: `category:place`, `genre:place:restaurant`, `amenity:qloo`, `amenities:place`, `beverage_offering:qloo`, `offerings:place`.
  So excluding a concept means listing every tag that expresses it.
- **Ask:** a concept-level exclusion (for example "serves alcohol"), or a documented list of the tags that imply it.
- **Effect on us:** an exact tag-ID deny list plus a token and name screen, with an allow list (`tea bar`, `espresso_bar`, `non_alcoholic`).
  Ambiguous hits go to clinician review. The bench measures whether this screen matters (10 in-recovery profiles): with the screen on, 0 of 30 outing cards carry an alcohol tag or keyword. Screen off, our 14-tag exclusion kept: 3 of 28. Screen off, only the 4 bar tags excluded: 21 of 28 (`bench/results.json`, `ablation_in_recovery`). It counts tags and keywords, not menus: a venue that serves alcohol under neither is not counted (README, Limitations 5).

## 3. Opening hours: day-level filter, and places with no hours

- `filter.hours=thursday` keeps places that are open on Thursday, but does not check the time of day.
  - In the run, Maya's query with `filter.hours=thursday` (radius 2500 m, no tag signal) returned 25 places.
  - 12 of them are closed at 18:00 by their own `properties.hours`.
- `/search?query=Dun-Well Doughnuts&types=urn:entity:place&filter.location=40.7081,-73.9571&filter.radius=1` returned 20 hits. **3 of them have no `properties.hours` object.**
  In the D1 spike, `GET /entities` did not fill in the missing hours (`spike/qloo-spike.json`, row E1: 0 of 4).
- Hours strings look like `"T08:00:00"`. An overnight close is written as an earlier clock time (`opens T18:00`, `closes T04:00`), so the client has to handle the wrap.
- **Ask:** a time-of-day form of `filter.hours` (for example `thursday@18:00`), and a flag saying whether hours are known.
- **Effect on us:** `slotStatus` in `lib/verify.ts` returns OPEN, CLOSED or UNKNOWN. UNKNOWN is refused and never assumed open.
  If a card is closed at its slot but open on the same day, it moves to an hour when it is open.

## 4. `/search` place matching is very fuzzy

```bash
curl -G https://hackathon.api.qloo.com/search -H "X-Api-Key: $QLOO_API_KEY" \
  --data-urlencode "query=Dun-Well Doughnuts" --data-urlencode "types=urn:entity:place" \
  --data-urlencode "filter.location=40.7081,-73.9571" --data-urlencode "filter.radius=1"
```

- 20 hits, and only 1 has the exact name. The others include six `Dunkin'` stores, "Stitch Well", "Restore Hyper Wellness" and a sex-toy shop.
- **Effect on our bench:** arm A (LLM-only plans) is graded by geocoding each stated address and matching a `/search` hit by name within 300 m.
  We ran that same pipeline on Rekindle's own cards (arm "B-sym"), which we already know are real Qloo places. It marked **6 of 66 unverifiable (9.1%)**.
  That is the noise floor of the name-plus-address match, so arm A's unverifiable count is inflated by up to that much.
  `bench/results.json` reports B-sym beside arm A for this reason.
- **Ask:** an exact-name mode, or a match score on `/search` hits.

## 5. `filter.location.query` is a loose locality

- A place query with `filter.location.query=Brooklyn` and `take=50` returned 50 places. **29 have an address outside Brooklyn**,
  for example MoMA PS1 (Queens), the Tenement Museum (Manhattan) and Westfield World Trade Center (Manhattan).
- **Effect on us:** "near the patient" uses `filter.location=POINT(lon lat)` + `filter.location.radius` (metres), and R-NEAR re-checks the distance.

## 6. Response shapes differ between endpoints

- Tag objects on `/v2/insights` have the keys `id, name, type, weight`. On `/search` they have `name, tag_id, type, value`.
- For an artist, `/v2/insights` returns `type: "urn:entity"`, and the concrete type is in `subtype: "urn:entity:artist"`.
- **Effect on us:** `tagIds()` in `lib/verify.ts` reads both `id` and `tag_id`, and the card type comes from `subtype`.

## 7. Explainability covers entity signals only

- With entity and tag signals together, `query.explainability` has only the key `signal.interests.entities`. The ramen tag signal is never listed, even though it changes the ranking.
  The D1 spike measured that change: Japanese or ramen places in the top 10 went from 0 to 4 (`spike/qloo-spike.json`, I3).
- **Effect on us:** a card's "because" line shows the per-love weights for entity loves. A pick driven by a tag love is explained by the place carrying that tag, which is a deterministic check and not a Qloo weight.

## 8. Butchers carry the generic `genre:place:restaurant` tag

```bash
curl -G https://hackathon.api.qloo.com/entities -H "X-Api-Key: $QLOO_API_KEY" \
  --data-urlencode "entity_ids=012DAD9B-33CE-4251-AB15-AB2CB702C920,F22DCC94-6BC4-47C9-BE4C-E65E0C4A10B9"
```

- **Observed:** The Meat Hook and Marlow & Daughters (butchers) both carry `urn:tag:genre:place:restaurant` and
  `urn:tag:genre:place:restaurant:butcher_shop`. Their `category:place:` tags say shop: The Meat Hook
  `meat_products_store`, `fruit_and_vegetable_store`, `butcher_shop`; Marlow & Daughters `grocery_store`, `butcher_shop`.
  Neither carries `urn:tag:category:place:restaurant` (`spike/dx-repro.json` → `F8_shop_restaurant_genre`).
- So a "restaurant" signal or filter on the genre tag returns shops. Both butchers came back to a Thursday outing query
  for Maya's loves (the capture above).
- **Effect on us:** R-KIND decides by the `category:place:` slugs, not by the restaurant genre, and refuses
  `butcher_shop` / `meat_products_store` even when another category passes.
  Since B6 it also refuses any drinking-establishment category (`bar`, `beer_hall`, `brewery`…) for every case, after the bench placed "TeKu Tavern + Café" (`cafe` + `bar` + `beer_hall`) for a profile not in recovery.

## What worked well

- `filter.location` POINT + radius, `filter.price_level.max`, `filter.tags` with `operator.filter.tags=intersection` (quiet + wheelchair entrance),
  `filter.exclude.entities` and `feature.explainability` all changed results as documented. In the D1 spike, 28 of 29 parameters changed results and passed their assertion (`spike/qloo-spike.json`).
- Responses are fast. The D1 spike measured a p50 of 410 ms over 43 calls.
