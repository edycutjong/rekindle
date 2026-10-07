import type { Metadata } from "next";
import Link from "next/link";
import { SiteHeader } from "@/components/SiteHeader";
import { StartCase } from "@/components/StartCase";
import r from "@/components/rekindle.module.css";
import { ARM_LABEL, benchRows, loadJudgeData, pctLabel, profilesWith } from "@/lib/judge";
import { latestReceipts, type Receipts } from "@/lib/receipts";
import { SEEDS } from "@/lib/service";
import { storeFromEnv } from "@/lib/store";
import s from "../integrations/qloo/qloo.module.css";
import j from "./judge.module.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Judge receipts · Rekindle" };

const seedLabel = (slug: string) => SEEDS.find((p) => p.slug === slug)?.label ?? slug;

/**
 * /judge (ui.md 8, build-plan D10): the receipts a judge needs without reading code — the six edge states to click,
 * the bench table (Qloo-graded and manually audited side by side), the ablation, re-plan responsiveness, and the
 * refusals by rule of the latest live runs. Every number is read from a committed script output or a stored call log.
 */
export default async function Judge() {
  const { bench, replan, audit } = await loadJudgeData();
  let live: Receipts | null = null;
  let liveError: string | null = null;
  try {
    live = await latestReceipts(storeFromEnv(), { limit: 5 });
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
              <table className={s.table} data-testid="bench-table">
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
                      <td>{x.label}</td>
                      <td>{x.venues}</td>
                      <td>
                        <b>{x.rate}</b> ({x.violations})
                      </td>
                      <td>{x.unverifiable}</td>
                      <td>{x.closed}</td>
                      <td>{x.alcohol}</td>
                      <td>{x.unknownHours}</td>
                      <td>{x.audited}</td>
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
                  Audit: {audit.method} Auditor: {audit.auditor}.
                </>
              ) : (
                "The manual audit has not been summarised yet."
              )}
            </p>

            <h2 className={s.h2}>Ablation: is the alcohol screen load-bearing?</h2>
            <div className={s.tableWrap}>
              <table className={s.table} data-testid="ablation-table">
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
                      <td>{ARM_LABEL[arm] ?? arm}</td>
                      <td>{a.pool_candidates}</td>
                      <td>
                        {a.pool_alcohol} ({pctLabel(a.pool_alcohol_rate)})
                      </td>
                      <td>
                        {a.profiles_with_pool_alcohol} / {a.profiles}
                      </td>
                      <td>
                        <b>{a.plan_alcohol_leak}</b> / {a.outing_cards} outings
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className={j.def}>{bench.definitions.ablation_pool}. Counted before any other rule runs; the last column is what would reach the sheet.</p>

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
          </>
        )}

        <h2 className={s.h2}>Latest live runs on this deployment</h2>
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
