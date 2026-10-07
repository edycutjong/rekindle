import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { SiteHeader } from "@/components/SiteHeader";
import { Workbench } from "@/components/Workbench";
import r from "@/components/rekindle.module.css";
import { canWrite } from "@/lib/owner";
import { storeFor } from "@/lib/scope";
import { latestVersion } from "@/lib/service";

export const dynamic = "force-dynamic";

const ID_RE = /^[0-9a-f-]{36}$/i;

/** "Week N · <label> · Rekindle"; a missing week is titled like every other 404 (QA round 3) */
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const store = storeFor({ headers: await headers() });
  const plan = await store.getPlan(id).catch(() => null);
  const c = plan ? await store.getCase(plan.case_id).catch(() => null) : null;
  return { title: plan && c ? `Week ${plan.week} · ${c.label} · Rekindle` : "Not found · Rekindle", robots: { index: false } };
}

/**
 * A stored week: the same ledger, read back from the store (reload shows the same week — D4 gate). A week that a
 * constraint toggle replaced redirects to its newest version (it can no longer be approved or printed), with a notice.
 */
export default async function PlanPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ replaced?: string }> }) {
  const { id } = await params;
  const replaced = (await searchParams).replaced;
  const h = await headers();
  const store = storeFor({ headers: h });
  const found = await store.getPlan(id).catch(() => null);
  if (!found) notFound();
  if (found.superseded_by) {
    const latest = await latestVersion(store, found);
    if (latest.id !== found.id) redirect(`/plans/${latest.id}?replaced=${found.id}`);
  }
  const plan = found;
  const c = await store.getCase(plan.case_id).catch(() => null);
  if (!c) notFound();
  // a re-planned week shows the rated week it came from, with the ember threads
  const previous = plan.diff ? await store.getPlan(plan.diff.from_plan_id).catch(() => null) : null;
  return (
    <div className={r.wrap}>
      <SiteHeader />
      <main>
        {replaced && ID_RE.test(replaced) && (
          <p className={r.notice} data-testid="superseded-notice" role="status">
            Plan {replaced.slice(0, 8)} was replaced by a constraint change; this is the newer version. The older one can no longer be approved or printed.
          </p>
        )}
        <Workbench initialCase={c} initialPlan={plan} previousPlan={previous} canEdit={canWrite({ headers: h }, c)} />
      </main>
    </div>
  );
}
