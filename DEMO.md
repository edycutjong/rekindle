# Demo: click path and bench

Live app: **https://rekindle.edycu.dev**. You do not need to log in. Every case is fictional.
Every plan, re-plan, swap and toggle below calls Qloo live; plans and re-plans also call the routing model. Nothing on the default path is replayed.

## Click path (about 4 minutes)

| # | Do | You should see |
|---|---|---|
| 1 | Open `/` and click **Plan Maya's week, live** | You land on `/cases/<id>`. Each day shows pencil-sketch lines. The **Agent trace** rail lists the tool calls as they happen (for example `findOutings day=thursday hour=18 …`). Cards are pencilled in as each tool returns. |
| 2 | Wait for the week (about 20 s) | 7 cards from Monday to Sunday: at-home doses, solo outings and one social outing. Each card has a **because** line with weights for her entity loves from Qloo explainability. Outings also show the distance, the opening hours and the slot with ✓ or a "moved from 18:00" note. Refused candidates stay in their slot, struck through, with their rule (`R-OPEN`, `R-KIND` …). The URL becomes `/plans/<id>`; reloading shows the same week. |
| 3 | Click **In recovery** in the constraint tabs | Only the affected outing slots are checked again, live. Venues with an alcohol tag or keyword are struck in place (`R-ALC …`, "struck when a constraint changed") and those slots are refilled. Ambiguous venues (for example bar seating only) show up in dashed **REVIEW · clinician decides** boxes. A notice gives the count and the time (live run [`ab088de3`](https://rekindle.edycu.dev/plans/ab088de3-3544-4a11-9c4e-033d2cf60965) on 8 Oct: "3 outings struck in place and 3 slots refilled live · 2.2 s"). |
| 4 | On one card, click **swap** | That one slot runs again through the same tool and verifier. Everything already on the sheet is excluded. The old card stays as a `CLINICIAN` strike. |
| 5 | Click **approve** on a card, then **Approve week** | Every card left on the sheet is stamped, and the sheet header shows the stamp ("APPROVED · <day> · <time> UTC"). The week is now locked. |
| 6 | Set **P** (pleasure) and **M** (mastery) on 3 cards. To see an ember thread, rate a food outing **8**, the at-home song **7** and one other card **2** (live re-plans: `c50f256b`, Patisserie Tomoko 8 + Lucy Dacus 7, drew 2 threads and 4 ties; [`e0adf88a`](https://rekindle.edycu.dev/plans/e0adf88a-6274-4b7e-a0af-428e3af9973e), the README's run on 8 Oct, Dun-Well Doughnuts 8 + Lucy Dacus 7 + Juice Generation 2, drew 2 threads and 2 ties; Maya's week varies, so pick the cards of that kind on yours) | The counter reads "3 rated · ready to re-plan" and **Re-plan week 2** is enabled. It stays disabled below 3 ratings. |
| 7 | Click **Re-plan week 2** | Week 2 streams in the same way. Above it, week 1 appears as rated: cards rated 7 or more get an ember underline, and cards rated 3 or less are struck as excluded. An ember thread joins a rekindled card to a week-2 card only when it is that card's top rated Qloo input and outweighs the case's best original love by at least 0.02, with the lead on the thread and any other rating that also outweighs the loves named on the label (live re-plan `c50f256b`: "← because of Patisserie Tomoko, rated 8 · 0.286, +0.035 over Phoebe Bridgers (original love) · with Lucy Dacus 0.252"); a smaller lead is labelled "tied with …" in muted ink and gets no thread. On live re-plans most leads are still ties: see /judge, `bench/ember-live.json`. It is Qloo's attribution, not causation. The top-rated activity comes back in its own slot, marked "↻ kept from last week", after a live Qloo `/entities` re-check of the same rules (open at the slot, near, price, alcohol, kind). Other activities rated 7 or more are listed under **Now a signal for week 2**. Anything the clinician swapped out or removed in week 1 never returns. Below week 2, a summary counts kept, new and rekindled cards, and **Leaving out** gives the reasons. |
| 8 | Go back to week 1 (or stay on any approved week) and click **Patient sheet** | `/plans/<id>/print` shows only the approved activities, each with what, when, where and the coaching line, plus empty P and M boxes to fill in by hand. It has no weights, rule IDs or strikes. A draft week prints nothing. |
| 9 | Open **Judge receipts** (`/judge`) | Six edge states (loading, refused, REVIEW, empty, coverage refusal, Qloo unavailable). Four have a live start button; refused and empty show on the weeks those start (struck candidates on Maya's week, empty slots in the outage demo). Below them: the bench table, the ablation, latency, re-plan N/N, and refusals by rule from the latest live runs. |
| 10 | Open **Qloo calls** (`/integrations/qloo`) | Every Qloo request behind the latest plans: path, parameters, status, ms and result count. The key is never shown. |

**Thin coverage:** on `/judge`, click **Plan Cal (sparse coverage)** (Bozeman, MT, with *quiet* on). The sheet says how many outings it could verify and why each empty slot is empty.
It offers a wider radius only with the clinician's consent. It never fills a slot with an unverified suggestion.

**Your own fictional case.** On `/`, **New fictional case** opens the intake (`/cases/new`): type 3–6 loves, confirm each against Qloo's live matches (`/search` for entities, `/v2/tags` for food and activities), pick a neighbourhood, energy, budget and constraints, and save. Week 1 then plans live, as in step 1.

**Week 2 is mostly new cards.** That is expected. When the signals change, Qloo returns different entities, so the diff usually reads "1 kept · 6 new · …" or "2 kept · 5 new · …": the kept activity, plus any card Qloo happens to return again.
The ember thread is drawn only where Qloo's own explainability puts a rated activity at least 0.02 above the case's best original love on that card (the same margin as `bench/replan.json`); ties are labelled as ties. Qloo's attribution, not causation.

## Bench (reproduce)

Every number below comes from the committed bench files. The table is pasted in by `scripts/bench_table.py`, not typed by hand.

```bash
# 1. plans for every arm on a live deployment (bench token = its own quota and its own store prefix)
BENCH_TOKEN=… QWEN_API_KEY=… QWEN_BASE_URL=https://dashscope-intl.aliyuncs.com/compatible-mode/v1 QWEN_MODEL=qwen3.8-flash \
  python3 scripts/bench.py --base https://rekindle.edycu.dev --out bench/results.json
# 2. re-plan responsiveness on arm B's week-1 plans
BENCH_TOKEN=… python3 scripts/replan_check.py --base https://rekindle.edycu.dev
# 2b. live ember margins over every stored re-plan, the hero week's included (needs the deployment's store env;
#     read-only): /judge's "Ember threads on this deployment" is this file
npx tsx scripts/ember-margins.ts --out bench/ember-live.json
# 3. manual audit sample (20 A + 20 B venues, fixed seed); fill the verdicts, then summarise
python3 scripts/manual_audit.py sample && python3 scripts/manual_audit.py summary --auditor "…" --method "…"
# 4. paste the numbers into README.md and DEMO.md
python3 scripts/bench_table.py
```

<!-- bench:table:start -->
**Automated checker.** On all 20 fictional profiles it flags 58 of the LLM's 79 venues and 6 of Rekindle's 66 (0 by Qloo ID), but it over-flags: in the same random sample, 4 of the 10 venues it couldn't match were real and open, because it matches by street address and misses large venues such as parks (`bench/results.json`, run 2026-10-07 13:11 UTC). This is why the manual audit leads.

_Generated by `python3 scripts/bench_table.py` from `bench/results.json` (scripts/bench.py, 20 profiles, 10 in recovery, against https://rekindle-one.vercel.app, finished 2026-10-07T13:11:44+00:00)._

**Run receipt:** 2026-10-07 12:58 to 2026-10-07 13:11 UTC, **822.8 s wall clock**; 40 Rekindle plans + 20 arm-A model plans; 386 Qloo calls on the plan path; 267 `/api/verify-venue` grading calls; 0 errors; model tokens not recorded by this run (`scripts/bench.py` sums provider-reported usage from the next run on). Plans routed by `qwen:qwen3.8-flash`; arm A on `qwen3.8-flash`. Provider cost: no dollar figure is claimed (the provider billing behind these keys is not readable from this repo).

**Wrong** = of the outing venues in each arm's plans across the seeded profiles, the share that are unverifiable, closed at the slot, or serve alcohol to a patient in recovery. **Unverifiable**: A / B-sym: the stated address does not geocode (Nominatim) or no Qloo /search place within 1 mile matches the name within 300 m. B: the card's entity id is not returned by Qloo /entities.

| Arm | Outing venues | Wrong (Qloo-graded) | Unverifiable | Closed at slot | Alcohol / in-recovery venues | Unknown hours | Wrong (manual audit) |
|---|---|---|---|---|---|---|---|
| A · LLM only (same model, asked for named venues) | 79 | 73.4% (58) | 48 | 9 | 1 / 37 | 2 | 41.2% (7/17, 3 inconclusive) |
| B · Rekindle | 66 | 0.0% (0) | 0 | 0 | 0 / 30 | 0 | 0.0% (0/14, 6 inconclusive) |
| B-sym · Rekindle's cards through arm A's address pipeline | 66 | 9.1% (6) | 6 | 0 | 0 / 30 | 0 | — |
| B− · screen off, 14-tag exclusion kept | 28 | 10.7% (3) | 0 | 0 | 3 / 28 | 0 | — |
| B−4 · screen off, 4 bar tags only | 28 | 75.0% (21) | 0 | 0 | 21 / 28 | 0 | — |

**Ablation** (10 in-recovery profiles): places Qloo returned that carry an alcohol tag, and how many reached the final plan.

| Arm | Places Qloo returned | Alcohol-flagged | Flagged places on the plan |
|---|---|---|---|
| B · Rekindle | 257 | 25 (9.7%) | 0 / 30 outings |
| B− · screen off, 14-tag exclusion kept | 232 | 21 (9.0%) | 3 / 28 outings |
| B−4 · screen off, 4 bar tags only | 295 | 183 (62.0%) | 21 / 28 outings |

**Latency** (hosted app, measured by the bench client from request to stored plan):

| Arm | Plans | p50 | p95 | Qloo calls per plan (mean) |
|---|---|---|---|---|
| B · Rekindle | 20 | 17.43 s | 20.61 s | 9.4 |
| B− · screen off, 14-tag exclusion kept | 10 | 18.76 s | 20.81 s | 10.1 |
| B−4 · screen off, 4 bar tags only | 10 | 18.01 s | 20.86 s | 9.6 |
| A · LLM only (same model, asked for named venues) (one model call, no Qloo) | 20 | 7.2 s | 8.3 s | 0 |

**Re-plan responsiveness: 16/16** (`bench/replan.json`). N = arm-B week-1 plans with >= 2 verified outings and >= 1 at-home card. PASS = week 2 has >= 1 new entity whose top-weighted explainability input is a >= 7-rated entity, and 0 entities with the <= 3-rated ID. margin = top rekindled weight - best original-love weight on a new card (Qloo's attribution, not a causal claim about the patient). PASS at the thread margin = PASS with at least one such card whose margin is >= thread_margin, the lead the product draws an ember thread for.
Excluded (week 1 too thin to rate): ruth, omar, hana, cal. Low-rated entities back in week 2: 0. New week-2 cards whose top input is a rekindled rating: 67 of 84; median margin over the best original love 0.0555.

**Manual audit** (`bench/audit.json`): the build agent (Claude), not blind: it ran the bench, so arm labels could be inferred from address style; no external human auditor yet.
<!-- bench:table:end -->

**How to read it.**

- **Qloo grades both arms**, so Rekindle's Qloo-graded rate is low by construction: its cards are Qloo entities that passed these exact checks.
  The useful comparisons are:
  - arm A against the manual audit;
  - the **B-sym** row: arm A's name-and-address pipeline applied to Rekindle's own cards, already known to be real. That gives the noise floor of the address match (see [DX-REPORT.md](DX-REPORT.md) §4). Part of arm A's unverifiable count is that noise.
  - the **ablation**: with the alcohol screen off (B−), in-recovery plans contain places with an alcohol tag or keyword. With only 4 bar tags excluded (B−4), most of their outings carry one. It counts tags and keywords, not menus (README, Limitations 5).
- **The manual audit was not blind.** The auditor was the build agent, which could infer the arm from the address style. **This repo cannot support a blind audit either:** the arm key was committed once (1c20454) and is readable in the public history, and joining `bench/manual_audit.csv` to `bench/results.json` on venue name recovers every row's arm. An external audit is therefore run outside the repo: `python3 scripts/manual_audit.py handout` writes a reshuffled, relabelled CSV (venue, address, slot only) beside the project, and the auditor is asked not to open the repo. Address style may still hint at the arm. No external audit has returned yet.

<!-- bench:predates:start -->
**This bench run predates 30 later changes to the plan path** (`git log` after `finished_at`, generated by `scripts/bench_table.py`). The numbers above were measured before them; the bench is re-run on the final deploy before submission.

- `4c5debc` REVIEW state: ambiguous venues ranked below the placed card are surfaced for clinician review (max 2 per slot, no extra request); a placed …
- `a535ac1` R-KIND: a drinking-establishment place category (bar, beer_hall, brewery, pub…) refuses the card for every case, even beside 'cafe' (B5 …
- `0c8fe00` Coverage: an LLM-narrowed outing query that verifies nothing is retried once at the case radius before the slot is left empty; the empty …
- `bc55721` COACH-ALC: drop LLM coaching lines that mention drinking on every case (the model never sees the recovery flag); switching 'In recovery' on …
- `638d75b` Re-plan remembers the clinician's refusals: cards swapped out or removed at the gate go to history.struck, are sent as …
- `387fd29` Re-plan keeps what she enjoyed: the top-rated (>=7) activity returns in its own slot after a live Qloo /entities re-check through the same …
- `deadfb0` R-KIND: 'bar' as a whole word of a place category (bar_grill, bar_and_grill, karaoke_bar…) plus gastropub, night club, lounge, …
- `73f163a` Verifier ledger: an R-OPEN miss re-slotted and placed that day is a move, not a refusal; the card keeps 'moved from 18:00 (closed then)', …
- `78513a1` One re-plan per rated week: a create-only runs/replan-<id> marker (Blob allowOverwrite:false / ETag ifMatch over a failed or stale one) is …
- `abfcc19` Coaching hand-off gets its own window: routing stops once every slot is routed, and the forced submitPlan call runs after it with a 6 s …
- `0d6aa30` Coverage refusal names the binding filter: each empty outing under optional filters gets one live probe (same query without …
- `32b969c` Fix the re-plan route refusing itself: the route claims runs/replan-<id> before opening the stream, and replanWeek's precheck then saw that …
- `bc88584` A constraint toggle replaces the week it was applied to: the parent gets superseded_by=<new week>; approve, card actions, toggles, ratings …
- `1667494` Ember thread only on a real lead: a rekindled input must beat the card's next-strongest explainability input by >= 0.02 (EMBER_MIN_MARGIN) …
- `ba014b8` COACH-DOSE truth-boundary rule: a coaching line that names a duration contradicting its card's dose is dropped and logged (at-home cards …
- `dc5de31` Coaching is a race, not a relay: the providers that did not fail routing each get one forced submitPlan call (own tool, so a loser can …
- `e0c048f` a2a r01 T1: a throwing tool leaves its day empty with a reason instead of dropping it from the week; guard Qloo 200s without results
- `d1c3367` a2a r01 T3: run-scoped Qloo deadline (40 s) so a slow Qloo cannot outlive maxDuration before the week is stored; a call refused before any …
- `d5a72cd` a2a r01 found: the deterministic fallback (the path a hung or failed LLM lands on) routes its slots concurrently instead of one Qloo round …
- `15f0ce3` T16 (a2a r04): ember thread when the top rated input outweighs the best original love by >= 0.02 (EMBER_MIN_MARGIN, the bench's margin); …
- `358ce8e` fix(trace): the agent trace credits each slot to the model that routed it and says why a call failed; /judge's bench heading reads "Bench: …
- `e132099` fix(agent): a routing token budget per provider (3,000) — past it the open slots move to the next route and the provider stays in the …
- `2f1e2fc` docs(agent): ROUTE_TOKEN_BUDGET's comment says what the evidence shows — Qwen routes in one step of parallel tool calls (QA)
- `de0410d` a2a r09: credit and progress from the model's own tool calls, not claimed.size
- `778c6ec` a2a r09: the coaching race is won by a usable call only; drop the dead COACH_ATTEMPT_MS
- `ff3e2d5` a2a r09: provider errors drop account ids before the trace, the stored plan and the plan API
- `763644e` a2a r09: one source for the empty-slot reason prefixes that double as state
- `c3daf85` a2a r10: the coaching race accepts a call only if the truth boundary would keep one of its lines
- `caf344e` a2a r10: routing has no submitPlan; the coaching race runs for every placed week
- `adc2b4a` a2a r10 (found while verifying): routing is no longer told to call submitPlan; coaching is not told to route
<!-- bench:predates:end -->

## End-to-end checks (Playwright, logged-out, live)

```bash
python3 -m venv .venv && . .venv/bin/activate && pip install playwright && playwright install chromium
python3 scripts/ui_smoke.py https://rekindle.edycu.dev /tmp/shots live    # the click path above; exits 1 on a failed gate
python3 scripts/edge_states.py https://rekindle.edycu.dev /tmp/shots live # the six edge states from /judge
```
