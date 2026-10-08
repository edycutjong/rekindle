import type { Metadata } from "next";
import Link from "next/link";
import { SiteHeader } from "@/components/SiteHeader";
import r from "@/components/rekindle.module.css";
import { latestReceipts, type Receipts } from "@/lib/receipts";
import { cachedLatestReceipts, RECEIPTS_PAUSED_NOTE, receiptsPaused } from "@/lib/receipts-cached";
import { storeFromEnv } from "@/lib/store";
import s from "./qloo.module.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Qloo receipts · Rekindle" };

const ID_RE = /^[0-9a-f-]{36}$/i;

/**
 * Sponsor verification view: every Qloo request behind the most recent plans, as stored by the plan
 * that made it — path, params, HTTP status, latency and result count. The key is never stored, so it cannot appear.
 */
export default async function QlooReceipts({ searchParams }: { searchParams: Promise<{ plan?: string }> }) {
  const { plan } = await searchParams;
  const planId = plan && ID_RE.test(plan) ? plan : null;
  let data: Receipts | null = null;
  let error: string | null = null;
  const paused = !planId && receiptsPaused();
  try {
    // one plan: two reads by path; the latest-plans view (a list()) is cached across instances or paused (a2a r06)
    if (planId) data = await latestReceipts(storeFromEnv(), { planId, limit: 5 });
    else if (!paused) data = await cachedLatestReceipts(5);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  return (
    <div className={r.wrap}>
      <SiteHeader />
      <main className={s.page}>
        <h1 className={s.title}>Qloo requests, as the agent made them</h1>
        <p className={s.lead}>
          {planId ? (
            <>
              One plan: <code>{planId}</code>. <Link className={r.link} href="/integrations/qloo">Show the latest plans</Link> ·{" "}
              <Link className={r.link} href={`/plans/${planId}`}>open its week</Link>
            </>
          ) : (
            <>The latest plans run on this deployment, newest first. Host: hackathon.api.qloo.com, GET only; the API key stays on the server and is never logged.</>
          )}
        </p>
        {paused && <p className={r.notice}>{RECEIPTS_PAUSED_NOTE}</p>}
        {error && <p className={r.errorBox}>Could not read the call logs: {error}</p>}
        {data && (
          <>
            <dl className={s.totals} data-testid="totals">
              <div>
                <dt>requests</dt>
                <dd>{data.totals.calls}</dd>
              </div>
              <div>
                <dt>non-200</dt>
                <dd>{data.totals.non200}</dd>
              </div>
              <div>
                <dt>endpoints</dt>
                <dd>{data.totals.endpoints.join(" · ") || "—"}</dd>
              </div>
              <div>
                <dt>latency p50 / p95</dt>
                <dd>{data.totals.p50 === null ? "—" : `${data.totals.p50} / ${data.totals.p95} ms`}</dd>
              </div>
              <div className={s.wide}>
                <dt>distinct parameters ({data.totals.params.length})</dt>
                <dd>{data.totals.params.join(" · ") || "—"}</dd>
              </div>
            </dl>
            {data.plans.length === 0 && <p>No plans yet on this deployment. <Link className={r.link} href="/">Plan Maya&apos;s week</Link> to make the first.</p>}
            {data.plans.map((p) => (
              <section key={p.plan.id} className={s.plan}>
                <h2 className={s.h2}>
                  <Link className={r.link} href={`/plans/${p.plan.id}`}>
                    week {p.plan.week} · {p.plan.origin === "toggle" ? "constraint change" : "agent run"} · plan {p.plan.id.slice(0, 8)}
                  </Link>
                </h2>
                <p className={s.meta}>
                  {new Date(p.plan.created_at).toUTCString()} · {p.calls.length} Qloo requests · {p.plan.cards} cards · {p.plan.refusals} refusals ·{" "}
                  {p.plan.llm_model ? `${p.plan.llm_provider}:${p.plan.llm_model}` : "deterministic route"} · {(p.plan.latency_ms / 1000).toFixed(1)} s
                </p>
                <div className={s.tableWrap}>
                  <table className={s.table}>
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>path</th>
                        <th>params</th>
                        <th>status</th>
                        <th>ms</th>
                        <th>results</th>
                      </tr>
                    </thead>
                    <tbody>
                      {p.calls.map((c, i) => (
                        <tr key={i}>
                          <td>{i + 1}</td>
                          <td>{c.path}</td>
                          <td className={s.params}>
                            {Object.entries(c.params_json).map(([k, v]) => (
                              <div key={k}>
                                <span className={s.k}>{k}</span>={v}
                              </div>
                            ))}
                          </td>
                          <td>{c.status}</td>
                          <td>{c.ms}</td>
                          <td>{c.n_results}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            ))}
          </>
        )}
      </main>
    </div>
  );
}
