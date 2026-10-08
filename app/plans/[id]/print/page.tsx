import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PrintButton } from "@/components/PrintButton";
import { readCase, readPlan } from "@/lib/reads";
import { printSheet, stampLabel } from "@/lib/view";
import s from "./print.module.css";

export const dynamic = "force-dynamic";
/** a missing week is titled as such (the 404 used to say "Activity sheet") */
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const plan = await readPlan(id);
  return { title: plan ? "Activity sheet · Rekindle" : "Not found · Rekindle", robots: { index: false } };
}

/**
 * Patient print view: the approved activities only, A4/Letter, with a P and M box to fill in by hand.
 * No strikes, trace, weights or rule IDs. A draft week prints nothing (nothing reaches the patient unapproved).
 */
export default async function PrintPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const plan = await readPlan(id);
  if (!plan) notFound();
  const c = await readCase(plan.case_id);
  if (!c) notFound();
  const sheet = printSheet(plan);

  return (
    <div className={s.page}>
      <nav className={s.screenOnly} aria-label="Print view">
        <Link href={`/plans/${plan.id}`}>← Back to the clinician sheet</Link>
        {sheet.printable && sheet.rows.length > 0 && <PrintButton />}
      </nav>

      <main className={s.sheet} data-testid="print-sheet">
        <header className={s.head}>
          <h1>
            {c.label}&rsquo;s week {plan.week}
          </h1>
          <p className={s.sub}>
            {plan.approved_at ? `Planned with your clinician · ${stampLabel(plan.approved_at)}` : "Not approved yet"}
          </p>
        </header>

        {plan.superseded_by ? (
          <p className={s.notice} data-testid="print-superseded">
            This version of the week was replaced by a constraint change and does not print.{" "}
            <Link href={`/plans/${plan.superseded_by}/print`}>Open the newer version</Link>.
          </p>
        ) : !sheet.printable ? (
          <p className={s.notice} data-testid="print-draft">
            This week is still a draft. The sheet prints once the clinician approves the week, so nothing reaches the patient unchecked.
          </p>
        ) : sheet.rows.length === 0 ? (
          <p className={s.notice}>No activities on this week were approved.</p>
        ) : (
          <>
            <table className={s.table}>
              <thead>
                <tr>
                  <th scope="col">Day</th>
                  <th scope="col">Activity</th>
                  <th scope="col">Where</th>
                  <th scope="col" className={s.pmHead}>
                    <abbr title="Pleasure: how much you enjoyed it, 0 to 10">P</abbr>
                  </th>
                  <th scope="col" className={s.pmHead}>
                    <abbr title="Mastery: how much you achieved, 0 to 10">M</abbr>
                  </th>
                </tr>
              </thead>
              <tbody>
                {sheet.rows.map((r) => (
                  <tr key={`${r.day}-${r.activity}`} data-testid="print-row">
                    <th scope="row" className={s.when}>
                      {r.day}
                      <span>{r.time}</span>
                    </th>
                    <td>
                      <strong className={s.act}>{r.activity}</strong>
                      <span className={s.kind}>{r.kind}</span>
                      {r.how && <span className={s.how}>{r.how}</span>}
                    </td>
                    <td className={s.where}>{r.where}</td>
                    <td className={s.box} aria-label="Pleasure, to fill in by hand" />
                    <td className={s.box} aria-label="Mastery, to fill in by hand" />
                  </tr>
                ))}
              </tbody>
            </table>
            <p className={s.foot}>
              After each activity, write two numbers from 0 to 10: <b>P</b>, how much you enjoyed it, and <b>M</b>, how much you got done. Any number is
              useful, including 0. Bring this sheet to your next session.
            </p>
          </>
        )}
        <p className={s.fine}>Fictional case · Rekindle is clinician support: no diagnosis, no medical advice.</p>
      </main>
    </div>
  );
}
