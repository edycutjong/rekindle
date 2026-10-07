# Demo: click path and bench

Live app: **https://rekindle-one.vercel.app**. You do not need to log in. Every case is fictional.
Every plan, re-plan, swap and toggle below calls Qloo live; plans and re-plans also call the routing model. Nothing on the default path is replayed.

## Click path (about 4 minutes)

| # | Do | You should see |
|---|---|---|
| 1 | Open `/` and click **Plan Maya's week, live** | You land on `/cases/<id>`. Each day shows pencil-sketch lines. The **Agent trace** rail lists the tool calls as they happen (for example `findOutings day=thursday hour=18 …`). Cards are pencilled in as each tool returns. |
| 2 | Wait for the week (about 20 s) | 7 cards from Monday to Sunday: at-home doses, solo outings and one social outing. Each card has a **because** line with per-love weights from Qloo explainability. Outings also show the distance, the opening hours and the slot with ✓ or a "moved from 18:00" note. Refused candidates stay in their slot, struck through, with their rule (`R-OPEN`, `R-KIND` …). The URL becomes `/plans/<id>`; reloading shows the same week. |
| 3 | Click **In recovery** in the constraint tabs | Only the affected outing slots are checked again, live. Venues that serve alcohol are struck in place (`R-ALC …`, "struck when a constraint changed") and those slots are refilled. Ambiguous venues (for example bar seating only) show up in dashed **REVIEW · clinician decides** boxes. A notice gives the count and the time ("2 outings struck in place and 2 slots refilled live · 2.0 s"). |
| 4 | On one card, click **swap** | That one slot runs again through the same tool and verifier. Everything already on the sheet is excluded. The old card stays as a `CLINICIAN` strike. |
| 5 | Click **approve** on a card, then **Approve week** | Every card left on the sheet is stamped, and the sheet header shows the stamp ("APPROVED · <day> · <time> UTC"). The week is now locked. |
| 6 | Set **P** (pleasure) and **M** (mastery) on 3 cards, for example 8, 9 and 2 | The counter reads "3 rated · ready to re-plan" and **Re-plan week 2** is enabled. It stays disabled below 3 ratings. |
| 7 | Click **Re-plan week 2** | Week 2 streams in the same way. Above it, week 1 appears as rated: cards rated 7 or more get an ember underline, and cards rated 3 or less are struck as excluded. An ember thread joins each rekindled card to the week-2 card whose top-weighted Qloo input it is, with the weight on the thread. The top-rated activity comes back in its own slot, marked "↻ kept from last week", after a live Qloo `/entities` re-check of the same rules (open at the slot, near, price, alcohol, kind). Other activities rated 7 or more are listed under **Now a signal for week 2**. Anything the clinician swapped out or removed in week 1 never returns. Below week 2, a summary counts kept, new and rekindled cards, and **Leaving out** gives the reasons. |
| 8 | Go back to week 1 (or stay on any approved week) and click **Patient sheet** | `/plans/<id>/print` shows only the approved activities, each with what, when, where and the coaching line, plus empty P and M boxes to fill in by hand. It has no weights, rule IDs or strikes. A draft week prints nothing. |
| 9 | Open **Judge receipts** (`/judge`) | Six edge states, each with a live start button (loading, refused, REVIEW, empty, coverage refusal, Qloo unavailable). Below them: the bench table, the ablation, latency, re-plan N/N, and refusals by rule from the latest live runs. |
| 10 | Open **Qloo calls** (`/integrations/qloo`) | Every Qloo request behind the latest plans: path, parameters, status, ms and result count. The key is never shown. |

**Thin coverage:** on `/judge`, click **Plan Cal (sparse coverage)** (Bozeman, MT, with *quiet* on). The sheet says how many outings it could verify and why each empty slot is empty.
It offers a wider radius only with the clinician's consent. It never fills a slot with an unverified suggestion.

**Your own fictional case.** On `/`, **New fictional case** opens the intake (`/cases/new`): type 3–6 loves, confirm each against Qloo's live matches (`/search` for entities, `/v2/tags` for food and activities), pick a neighbourhood, energy, budget and constraints, and save. Week 1 then plans live, as in step 1.

**Week 2 is mostly new cards.** That is expected. When the signals change, Qloo returns different entities, so the diff usually reads "1 kept · 6 new · …" or "2 kept · 5 new · …": the kept activity, plus any card Qloo happens to return again.
The ember thread is drawn only where Qloo's own explainability names a rated activity as a card's strongest input.

## Bench (reproduce)

Every number below comes from the committed bench files. The table is pasted in by `scripts/bench_table.py`, not typed by hand.

```bash
# 1. plans for every arm on a live deployment (bench token = its own quota and its own store prefix)
BENCH_TOKEN=… QWEN_API_KEY=… QWEN_BASE_URL=https://dashscope-intl.aliyuncs.com/compatible-mode/v1 QWEN_MODEL=qwen3.8-flash \
  python3 scripts/bench.py --base https://rekindle-one.vercel.app --out bench/results.json
# 2. re-plan responsiveness on arm B's week-1 plans
BENCH_TOKEN=… python3 scripts/replan_check.py --base https://rekindle-one.vercel.app
# 3. manual audit sample (20 A + 20 B venues, fixed seed); fill the verdicts, then summarise
python3 scripts/manual_audit.py sample && python3 scripts/manual_audit.py summary --auditor "…" --method "…"
# 4. paste the numbers into README.md and DEMO.md
python3 scripts/bench_table.py
```

<!-- bench:table:start -->
_Generated by `python3 scripts/bench_table.py` from `bench/results.json` (scripts/bench.py, 20 profiles, 10 in recovery, against https://rekindle-one.vercel.app, finished 2026-10-07T13:11:44+00:00)._

**Wrong** = of the outing venues in each arm's plans across the seeded profiles, the share that are unverifiable, closed at the slot, or serve alcohol to a patient in recovery. **Unverifiable**: A / B-sym: the stated address does not geocode (Nominatim) or no Qloo /search place within 1 mile matches the name within 300 m. B: the card's entity id is not returned by Qloo /entities.

| Arm | Outing venues | Wrong (Qloo-graded) | Unverifiable | Closed at slot | Alcohol / in-recovery venues | Unknown hours | Wrong (manual audit) |
|---|---|---|---|---|---|---|---|
| A · LLM only (same model, asked for named venues) | 79 | 73.4% (58) | 48 | 9 | 1 / 37 | 2 | 41.2% (7/17, 3 inconclusive) |
| B · Rekindle | 66 | 0.0% (0) | 0 | 0 | 0 / 30 | 0 | 0.0% (0/14, 6 inconclusive) |
| B-sym · Rekindle's cards through arm A's address pipeline | 66 | 9.1% (6) | 6 | 0 | 0 / 30 | 0 | — |
| B− · Rekindle, alcohol screen off | 28 | 10.7% (3) | 0 | 0 | 3 / 28 | 0 | — |
| B−4 · screen off, 4 bar tags only | 28 | 75.0% (21) | 0 | 0 | 21 / 28 | 0 | — |

**Ablation** (10 in-recovery profiles): places Qloo returned that carry an alcohol tag, and how many reached the final plan.

| Arm | Places Qloo returned | Alcohol-flagged | Flagged places on the plan |
|---|---|---|---|
| B · Rekindle | 257 | 25 (9.7%) | 0 / 30 outings |
| B− · Rekindle, alcohol screen off | 232 | 21 (9.0%) | 3 / 28 outings |
| B−4 · screen off, 4 bar tags only | 295 | 183 (62.0%) | 21 / 28 outings |

**Latency** (hosted app, measured by the bench client from request to stored plan):

| Arm | Plans | p50 | p95 | Qloo calls per plan (mean) |
|---|---|---|---|---|
| B · Rekindle | 20 | 17.43 s | 20.61 s | 9.4 |
| B− · Rekindle, alcohol screen off | 10 | 18.76 s | 20.81 s | 10.1 |
| B−4 · screen off, 4 bar tags only | 10 | 18.01 s | 20.86 s | 9.6 |
| A · LLM only (same model, asked for named venues) (one model call, no Qloo) | 20 | 7.2 s | 8.3 s | 0 |

**Re-plan responsiveness: 16/16** (`bench/replan.json`). N = arm-B week-1 plans with >= 2 verified outings and >= 1 at-home card. PASS = week 2 has >= 1 new entity whose top-weighted explainability input is a >= 7-rated entity, and 0 entities with the <= 3-rated ID. margin = top rekindled weight - best original-love weight on a new card (Qloo's attribution, not a causal claim about the patient).
Excluded (week 1 too thin to rate): ruth, omar, hana, cal. Low-rated entities back in week 2: 0. New week-2 cards whose top input is a rekindled rating: 67 of 84; median margin over the best original love 0.0555.

**Manual audit** (`bench/audit.json`): the build agent (Claude), not blind: it ran the bench, so arm labels could be inferred from address style; no external human auditor yet.
<!-- bench:table:end -->

**How to read it.**

- **Qloo grades both arms**, so Rekindle's Qloo-graded rate is low by construction: its cards are Qloo entities that passed these exact checks.
  The useful comparisons are:
  - arm A against the manual audit;
  - the **B-sym** row: arm A's name-and-address pipeline applied to Rekindle's own cards, already known to be real. That gives the noise floor of the address match (see [DX-REPORT.md](DX-REPORT.md) §4). Part of arm A's unverifiable count is that noise.
  - the **ablation**: with the alcohol screen off (B−), in-recovery plans contain alcohol-serving places. With only 4 bar tags excluded (B−4), most of them do.
- **The manual audit was not blind.** The auditor was the build agent, which could infer the arm from the address style. An external blind audit is still to come.

<!-- bench:predates:start -->
**This bench run predates 11 later changes to the plan path** (`git log` after `finished_at`, generated by `scripts/bench_table.py`). The numbers above were measured before them; the bench is re-run on the final deploy before submission.

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
<!-- bench:predates:end -->

## End-to-end checks (Playwright, logged-out, live)

```bash
pip install playwright && playwright install chromium
python3 scripts/ui_smoke.py https://rekindle-one.vercel.app /tmp/shots live    # the click path above; exits 1 on a failed gate
python3 scripts/edge_states.py https://rekindle-one.vercel.app /tmp/shots live # the six edge states from /judge
```
