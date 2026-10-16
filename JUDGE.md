# For judges

This file mirrors the top of [`/judge`](https://rekindle.edycu.dev/judge) on the live app (the claim, the path, the receipts, the reproduce command, the limitations and the links); the page adds the six edge states (four with a live start button; refused and empty show on the weeks those start) and the full bench. No login, no keys, no cloning. Every case is fictional.

## The claim

**Rekindle is a behavioral-activation planning agent for clinicians.** It turns what a depressed patient used to love into a week of real, open, nearby activities, verified with Qloo, approved by the clinician, and re-planned from the patient's own pleasure ratings.

## The 30-second path

1. Open **https://rekindle.edycu.dev** and click **Plan Maya's week, live**. The agent trace lists each Qloo call as it happens; the week arrives in about 20 s.
2. Click **In recovery**. Alcohol-serving venues are struck in place with their rule (`R-ALC …`) and those slots are refilled live.
3. Open [`/judge`](https://rekindle.edycu.dev/judge) for the six edge states (four with a live start button; refused and empty show on the weeks those start) and the bench, and [`/integrations/qloo`](https://rekindle.edycu.dev/integrations/qloo) for every Qloo request behind the latest plans (the key is never shown).

The full click path (swap, approve, rate, re-plan week 2, patient sheet) is in [DEMO.md](DEMO.md), about 4 minutes.

## Receipts

<!-- bench:killer:start -->
**Asked for named places, the same LLM got 7 of 17 audited venues wrong (41.2%); Rekindle: 0 of 14.** Wrong means not found (4), closed at the planned hour (2) or serving alcohol to a patient in recovery (1); a random 20 per arm, checked one by one against public listings by our build agent (Claude, an AI; not blind), 3 and 6 inconclusive (`bench/audit.json`). Our automated checker, on all 20 fictional profiles, flags 58 of the LLM's 79 venues and 6 of Rekindle's 66 (0 by Qloo ID), but it over-flags: in the same random sample, 4 of the 10 venues it couldn't match were real and open, because it matches by street address and misses large venues such as parks (`bench/results.json`, run 2026-10-07 13:11 UTC).
<!-- bench:killer:end -->

| Receipt | Value | Source |
|---|---|---|
| Plan latency, hosted (arm B, 20 plans) | p50 17.43 s · p95 20.61 s · 9.4 Qloo calls per plan | `bench/results.json` |
| Re-plan responsiveness | 16/16 eligible profiles; 0 low-rated entities back in week 2 | `bench/replan.json` |
| Unit + property tests | 249 Vitest tests, 20 files, no keys needed | `npm test` |
| Property check of the verifier | 60,000 generated cases (3 properties × 20,000, fixed seeds): in none did a PASS outing break a hard constraint, a deny-listed alcohol tag escape refusal in recovery, or missing hours count as open | `tests/verify.property.test.ts` |
| E2E | Playwright, desktop + Pixel 7, in CI; `scripts/ui_smoke.py` drives the whole live flow (18 gates) | `e2e/`, `scripts/` |

<!-- bench:ember:start -->
**Ember threads on live re-plans** (`bench/ember-live.json`, `scripts/ember-margins.ts`, 2026-10-08 08:33 UTC): 7 re-plans with 3 distinct rating sets (Qloo returns the same week for the same ratings). Of 16 distinct new week-2 cards that name a rating, a rating outweighed the case's best original love on 11; 2 cleared the 0.02 lead that draws a thread and 9 are shown as ties. The previous rule (a lead over the next input of any kind) threaded 2 of the same cards. On the bench's 84 new week-2 cards (`bench/replan.json`, the same margin), 50 clear it. The live sample is small; Qloo's attribution, not causation.
<!-- bench:ember:end -->

<!-- bench:caveat:start -->
**Caveat: this bench run predates 30 later changes to the plan path** (listed in [DEMO.md](DEMO.md#bench-reproduce)). Every bench number on this page, latency included, was measured before them; the bench is re-run on the final deploy before submission.
<!-- bench:caveat:end -->

[DEMO.md](DEMO.md#bench-reproduce) explains how to read the table (Qloo grades both arms; the manual audit was not blind).

## Reproduce (the real path)

```bash
# the product, live: plans call Qloo and the routing model; nothing on this path is replayed
python3 scripts/ui_smoke.py https://rekindle.edycu.dev /tmp/shots live
E2E_BASE_URL=https://rekindle.edycu.dev E2E_LIVE=1 npx playwright test e2e/live-plan.spec.ts --project=chromium
# the bench, against a live deployment (needs BENCH_TOKEN and model keys): see DEMO.md "Bench (reproduce)"
```

**CI / deterministic, not the product:** `npm run check` and `npx playwright test` run with no keys. In that mode the app refuses to plan ("The plan could not finish … No week is invented") and the E2E suite asserts exactly that.

## Honest limitations

1. **Not a clinical tool.** Clinician support only: no diagnosis, no efficacy claims, no patient logins.
2. **A plan is slow:** p50 about 17 s from click, inside our 30 s gate but over the 15 s target.
3. **The ember thread is Qloo's attribution, not causation.** It needs the top rated input to outweigh the case's best original love by 0.02; on live re-plans most leads are still ties (above).
4. **The alcohol screen is a deny list.** It is measured by the ablation, but an alcohol-serving venue with none of the tags or keywords would get through.

The full list is in the [README](README.md) (Limitations).

## Links

- Demo video (2:29): https://youtu.be/a2axsKACYsk
- Live app: https://rekindle.edycu.dev · receipts: https://rekindle.edycu.dev/judge
- Repository: https://github.com/edycutjong/rekindle
- Architecture (generated from the code): [ARCHITECTURE.md](ARCHITECTURE.md) · Qloo DX report: [DX-REPORT.md](DX-REPORT.md)
