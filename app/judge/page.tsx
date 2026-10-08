import type { Metadata } from "next";
import Link from "next/link";
import { SiteHeader } from "@/components/SiteHeader";
import { StartCase } from "@/components/StartCase";
import r from "@/components/rekindle.module.css";
import rigorJson from "@/docs/rigor.json";
import { ARM_LABEL, benchReceipt, benchRows, loadJudgeData, oracleOverFlag, pctLabel, profilesWith, type Rigor } from "@/lib/judge";
import { cachedLatestReceipts, RECEIPTS_PAUSED_NOTE, receiptsPaused } from "@/lib/receipts-cached";
import { type Receipts } from "@/lib/receipts";
import { SEEDS } from "@/lib/service";
import s from "../integrations/qloo/qloo.module.css";
import j from "./judge.module.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Judge receipts · Rekindle" };

const REPO = "https://github.com/edycutjong/rekindle";
const LIVE = "https://rekindle.edycu.dev";
const rigor: Rigor = rigorJson;

const seedLabel = (slug: string) => SEEDS.find((p) => p.slug === slug)?.label ?? slug;

/**
 * /judge: the receipts a judge needs without reading code — the claim, the 30-second path, how to reproduce, the honest
 * limitations and the links (mirrored in JUDGE.md), then the six edge states to click,
 * the bench table (Qloo-graded and manually audited side by side), the ablation, re-plan responsiveness, and the
 * refusals by rule of the latest live runs. Every number is read from a committed script output or a stored call log.
 */
export default async function Judge() {
  const { bench, replan, audit, predates, emberLive } = await loadJudgeData();
  let live: Receipts | null = null;
  let liveError: string | null = null;
  const paused = receiptsPaused();
  try {
    if (!paused) live = await cachedLatestReceipts(5);
  } catch (e) {
    liveError = e instanceof Error ? e.message : String(e);
  }
  const review = profilesWith(bench, "review");
  const coverage = profilesWith(bench, "coverage");
  const reviewSlug = review.find((x) => x !== "maya") ?? review[0] ?? null;
  const coverageSlug = coverage.includes("cal") ? "cal" : (coverage[0] ?? null);

  return (
    <div className={r.wrap}>
      <SiteHeader />
      <main className={s.page}>
        <h1 className={s.title}>Receipts: what the agent did, and how often a plan was wrong</h1>
        <p className={s.lead}>
          No login. Every case is fictional. Plans below run live against Qloo and the model when you click; nothing on this page is replayed. Numbers come from{" "}
          <code>bench/results.json</code>, <code>bench/replan.json</code> and <code>bench/audit.json</code> in the repository (written by the scripts named beside them)
          and from the stored Qloo call logs of this deployment.
        </p>

        <h2 className={s.h2}>The claim</h2>
        <p className={j.claim} data-testid="claim">
          <b>Rekindle is a behavioral-activation planning agent for clinicians.</b> It turns what a depressed patient used to love into a week of real, open, nearby
          activities, verified with Qloo, approved by the clinician, and re-planned from the patient&apos;s own pleasure ratings.
        </p>

        <h2 className={s.h2}>The 30-second path</h2>
        <ol className={j.states} data-testid="click-path">
          <li>
            Open <Link className={r.link} href="/">the live app</Link> and click <b>Plan Maya&apos;s week, live</b>. The agent trace lists each Qloo call as it happens;
            the week arrives in about 20 s.
          </li>
          <li>
            Click <b>In recovery</b>. Alcohol-serving venues are struck in place with their rule (<code>R-ALC …</code>) and those slots are refilled live.
          </li>
          <li>
            Come back here for the six edge states (each with a live start button) and the bench, and open{" "}
            <Link className={r.link} href="/integrations/qloo">
              /integrations/qloo
            </Link>{" "}
            for every Qloo request behind the latest plans (the key is never shown).
          </li>
        </ol>
        <p className={j.def}>
          The full click path (swap, approve, rate, re-plan week 2, patient sheet) is in{" "}
          <a className={r.link} href={`${REPO}/blob/main/DEMO.md`}>
            DEMO.md
          </a>
          , about 4 minutes.
        </p>

        <h2 className={s.h2}>Receipts in one line</h2>
        <p className={j.def} data-testid="receipt-line">
          <b>
            {rigor.tests} Vitest tests in {rigor.files} files
          </b>
          , no keys needed (<code>npm test</code>) · <b>{rigor.property_cases.toLocaleString("en-US")} generated verifier cases</b> ({rigor.properties} properties ×{" "}
          {rigor.runs_per_property.toLocaleString("en-US")}, fixed seeds): no PASS outing ever breaks a hard constraint
          {bench && (
            <>
              {" "}
              · {benchReceipt(bench)} (<code>bench/results.json</code>)
            </>
          )}
          .
        </p>

        <h2 className={s.h2}>Reproduce (the real path)</h2>
        <pre className={j.cmd} data-testid="reproduce">
          {`# the product, live: plans call Qloo and the routing model; nothing on this path is replayed
git clone ${REPO} && cd rekindle && npm ci
python3 scripts/ui_smoke.py ${LIVE} /tmp/shots live
E2E_BASE_URL=${LIVE} E2E_LIVE=1 npx playwright test e2e/live-plan.spec.ts --project=chromium
# the bench, against a live deployment (needs BENCH_TOKEN and model keys): DEMO.md "Bench (reproduce)"`}
        </pre>
        <p className={j.def}>
          <b>CI / deterministic, not the product:</b> <code>npm run check</code> and <code>npx playwright test</code> run with no keys. In that mode the app refuses to
          plan (&ldquo;No week is invented&rdquo;) and the E2E suite asserts exactly that.
        </p>

        <h2 className={s.h2}>Honest limitations</h2>
        <ol className={j.states} data-testid="limitations">
          <li>
            <b>Not a clinical tool.</b> Clinician support only: no diagnosis, no efficacy claims, no patient logins.
          </li>
          <li>
            <b>A plan is slow:</b> p50 about 17 s from click in the bench, inside our 30 s gate but over the 15 s target.
          </li>
          <li>
            <b>The ember thread is attribution, not causation</b>, and on live re-plans most leads are ties (see re-plan responsiveness below).
          </li>
          <li>
            <b>The alcohol screen is a deny list.</b> It is measured by the ablation below, but an alcohol-serving venue with none of the tags or keywords would get
            through.
          </li>
        </ol>
        <p className={j.def}>
          All seven are in the{" "}
          <a className={r.link} href={`${REPO}#limitations-honest-limits-7`}>
            README (Limitations)
          </a>
          .
        </p>

        <h2 className={s.h2}>Links</h2>
        <ul className={j.links} data-testid="links">
          <li>
            <a className={`${r.link} ${r.linkTarget}`} href={REPO}>
              GitHub repository
            </a>
          </li>
          <li>
            <a className={`${r.link} ${r.linkTarget}`} href={LIVE}>
              Live app
            </a>
          </li>
          <li>
            <a className={`${r.link} ${r.linkTarget}`} href={`${REPO}/blob/main/DEMO.md`}>
              DEMO.md (click path + bench)
            </a>
          </li>
          <li>
            <a className={`${r.link} ${r.linkTarget}`} href={`${REPO}/blob/main/JUDGE.md`}>
              JUDGE.md (this page as a file)
            </a>
          </li>
          <li>
            <a className={`${r.link} ${r.linkTarget}`} href={`${REPO}/blob/main/ARCHITECTURE.md`}>
              ARCHITECTURE.md (generated from the code)
            </a>
          </li>
          <li>
            <a className={`${r.link} ${r.linkTarget}`} href={`${REPO}/blob/main/DX-REPORT.md`}>
              Qloo DX report
            </a>
          </li>
        </ul>

        <h2 className={s.h2}>Six states to check</h2>
        <ol className={j.states} data-testid="edge-states">
          <li>
            <b>Loading.</b> Pencilled lines fill each day while the agent works; cards are pencilled in as each tool returns.
            <span className={j.go}>
              <StartCase slug="maya" label="Plan Maya's week, live" primary />
            </span>
          </li>
          <li>
            <b>Refused.</b> Candidates the verifier refused stay in their slot, struck through, with the rule beneath. Toggle <i>in recovery</i> on Maya&apos;s sheet to
            strike bars in place.
          </li>
          <li>
            <b>REVIEW.</b> A candidate the screen cannot decide (e.g. bar seating alone on an in-recovery case) goes to the clinician in a dashed box, never onto the
            sheet unasked. This runs Maya with <i>in recovery</i> already on, so the screen checks every outing candidate Qloo returns; how many land in REVIEW
            depends on what Qloo returns that day.
            <span className={j.go}>
              <StartCase slug="maya" preset="recovery" label="Plan Maya in recovery, live" />
              {reviewSlug && reviewSlug !== "maya" && (
                <>
                  {" "}
                  <StartCase slug={reviewSlug} label={`Plan ${seedLabel(reviewSlug)} (REVIEW in the bench run)`} />
                </>
              )}
            </span>
          </li>
          <li>
            <b>Empty.</b> A slot with no verified candidate is left empty with the reason. Also: the clinician&apos;s <i>remove</i>.
          </li>
          <li>
            <b>Coverage refusal.</b> When outings within the radius cannot be verified, the sheet says how many and why, and offers a wider radius only with clinician
            consent.
            {coverageSlug ? (
              <span className={j.go}>
                <StartCase slug={coverageSlug} label={`Plan ${seedLabel(coverageSlug)} (sparse coverage)`} />
              </span>
            ) : (
              <span className={r.reason}> No seeded profile hit a coverage refusal in the last bench run.</span>
            )}
          </li>
          <li>
            <b>Qloo unavailable.</b> Labelled demo: runs Maya with an unreachable Qloo host on purpose. Every slot stays empty with the reason; the model fills nothing on
            its own. It sends no request and is left out of the receipts.
            <span className={j.go}>
              <StartCase slug="maya" label="Run the outage demo" fault />
            </span>
          </li>
        </ol>

        <h2 className={s.h2}>Bench: the killer number</h2>
        {predates && predates.commits.length > 0 && (
          <details className={j.def} data-testid="bench-predates">
            <summary>
              <b>This bench run predates {predates.commits.length} later changes to the plan path.</b> The numbers below were measured before them; the bench is re-run on the final deploy before submission.
            </summary>
            <ul>
              {predates.commits.map((c) => (
                <li key={c.commit}>
                  <code>{c.commit}</code> {c.subject}
                </li>
              ))}
            </ul>
          </details>
        )}
        {!bench ? (
          <p data-testid="bench-missing">The bench has not been run on this deployment yet (scripts/bench.py writes bench/results.json).</p>
        ) : (
          <>
            <p className={s.meta}>
              scripts/bench.py · {bench.profiles} seeded profiles ({bench.in_recovery_profiles} in recovery) · finished {bench.finished_at} · against {bench.base}
            </p>
            <p className={j.def}>
              <b>Definition.</b> {bench.definitions.killer_number}. Unverifiable: {bench.definitions.unverifiable}. <i>Unknown hours</i> is its own column: Rekindle refuses
              unknown hours by construction.
            </p>
            <div className={s.tableWrap}>
              <table className={`${s.table} ${j.stack}`} data-testid="bench-table">
                <thead>
                  <tr>
                    <th>arm</th>
                    <th>outing venues</th>
                    <th>wrong (Qloo-graded)</th>
                    <th>unverifiable</th>
                    <th>closed at slot</th>
                    <th>alcohol / in-recovery venues</th>
                    <th>unknown hours</th>
                    <th>wrong (manual audit)</th>
                  </tr>
                </thead>
                <tbody>
                  {benchRows(bench, audit).map((x) => (
                    <tr key={x.arm}>
                      <th scope="row" className={j.armCell}>
                        {x.label}
                      </th>
                      <td data-label="outing venues">{x.venues}</td>
                      <td data-label="wrong (Qloo-graded)" className={j.key}>
                        <b>{x.rate}</b> ({x.violations})
                      </td>
                      <td data-label="unverifiable">{x.unverifiable}</td>
                      <td data-label="closed at slot">{x.closed}</td>
                      <td data-label="alcohol / in-recovery" className={j.key}>
                        {x.alcohol}
                      </td>
                      <td data-label="unknown hours">{x.unknownHours}</td>
                      <td data-label="wrong (manual audit)" className={j.key}>
                        {x.audited}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className={j.def}>
              <b>Bias.</b> {bench.definitions.oracle}. So Rekindle&apos;s Qloo-graded rate is low by construction; the manual audit checks
              the venues against public listings instead.{" "}
              {audit ? (
                <>
                  Audit: {audit.method} Auditor: {audit.auditor}. {oracleOverFlag(audit)}
                </>
              ) : (
                "The manual audit has not been summarised yet."
              )}
            </p>

            <h2 className={s.h2}>Ablation: is the alcohol screen load-bearing?</h2>
            <div className={s.tableWrap}>
              <table className={`${s.table} ${j.stack}`} data-testid="ablation-table">
                <thead>
                  <tr>
                    <th>arm</th>
                    <th>places Qloo returned</th>
                    <th>of them alcohol-flagged</th>
                    <th>profiles with a flagged place</th>
                    <th>flagged places on the final plan</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(bench.ablation_in_recovery).map(([arm, a]) => (
                    <tr key={arm}>
                      <th scope="row" className={j.armCell}>
                        {ARM_LABEL[arm] ?? arm}
                      </th>
                      <td data-label="places Qloo returned">{a.pool_candidates}</td>
                      <td data-label="of them alcohol-flagged">
                        {a.pool_alcohol} ({pctLabel(a.pool_alcohol_rate)})
                      </td>
                      <td data-label="profiles with a flagged place">
                        {a.profiles_with_pool_alcohol} / {a.profiles}
                      </td>
                      <td data-label="flagged places on the final plan" className={j.key}>
                        <b>{a.plan_alcohol_leak}</b> / {a.outing_cards} outings
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className={j.def}>{bench.definitions.ablation_pool}. The last column is what would reach the sheet.</p>

            <h2 className={s.h2}>Latency</h2>
            <dl className={s.totals} data-testid="latency">
              {Object.entries(bench.latency).map(([arm, l]) => (
                <div key={arm}>
                  <dt>{arm === "A" ? "arm A model call p50 / p95" : `${arm} plan p50 / p95 (client)`}</dt>
                  <dd>{arm === "A" ? `${l.llm_p50_s} / ${l.llm_p95_s} s` : `${l.client_p50_s} / ${l.client_p95_s} s · ${l.qloo_calls_mean} Qloo calls avg`}</dd>
                </div>
              ))}
            </dl>
          </>
        )}

        <h2 className={s.h2}>Re-plan responsiveness</h2>
        {!replan ? (
          <p>scripts/replan_check.py has not been run yet.</p>
        ) : (
          <>
            <p className={j.big} data-testid="replan-result">
              {replan.result}
            </p>
            <p className={j.def}>
              {replan.definition} Excluded: {replan.excluded.length ? replan.excluded.map((x) => `${seedLabel(x.profile)} (${x.reason})`).join("; ") : "none"}. Low-rated
              entities back in week 2: {replan.low_rated_reappearing}. New week-2 cards whose top input is a rekindled rating: {replan.attributed_new_cards_total} of{" "}
              {replan.new_cards_total}. Median margin over the best original love: {replan.ember_margin_median_of_profiles ?? "—"}. Re-plan p50 {replan.replan_seconds_p50} s.
            </p>
            {emberLive && (
              <p className={j.def} data-testid="ember-live">
                <strong>Live margins on this deployment</strong> (<code>bench/ember-live.json</code>, scripts/ember-margins.ts, {emberLive.generated_at.slice(0, 16).replace("T", " ")} UTC): over{" "}
                {emberLive.replans} re-plans, {emberLive.rekindled_top} new cards had a rated activity as their strongest input. Median lead{" "}
                {emberLive.margin_median ?? "—"} over the next input ({emberLive.margin_over_original_loves_median ?? "—"} over the best original love, the bench&apos;s measure, against its{" "}
                {replan.ember_margin_median_of_profiles ?? "—"}). {emberLive.threaded} cleared the {emberLive.threshold} lead the product needs to draw an ember thread and say
                &ldquo;because of&rdquo;; the other {emberLive.tied} are shown as ties.
                {emberLive.tied > emberLive.threaded && " Qloo splits explainability nearly evenly across signals, so most live re-plan picks are not attributable to one rating."}
              </p>
            )}
          </>
        )}

        <h2 className={s.h2}>Latest live runs on this deployment</h2>
        {paused && <p className={r.notice}>{RECEIPTS_PAUSED_NOTE}</p>}
        {liveError && <p className={r.errorBox}>Could not read the call logs: {liveError}</p>}
        {live && (
          <dl className={s.totals} data-testid="live-totals">
            <div>
              <dt>plans</dt>
              <dd>{live.plans.length}</dd>
            </div>
            <div>
              <dt>Qloo requests</dt>
              <dd>
                {live.totals.calls} ({live.totals.non200} non-200)
              </dd>
            </div>
            <div>
              <dt>sent to clinician review</dt>
              <dd>{live.totals.review}</dd>
            </div>
            <div className={s.wide}>
              <dt>refusals by rule</dt>
              <dd data-testid="refusals-by-rule">
                {Object.entries(live.totals.refusals_by_rule)
                  .sort((a, b) => b[1] - a[1])
                  .map(([k, v]) => `${k} ${v}`)
                  .join(" · ") || "—"}
              </dd>
            </div>
            <div className={s.wide}>
              <dt>endpoints · distinct parameters ({live.totals.params.length})</dt>
              <dd>
                {live.totals.endpoints.join(" · ")} — {live.totals.params.join(" · ")}
              </dd>
            </div>
          </dl>
        )}
        <p>
          <Link className={r.link} href="/integrations/qloo">
            Every Qloo request of those runs, with its parameters →
          </Link>
        </p>
      </main>
    </div>
  );
}
