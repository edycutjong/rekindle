import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { SiteHeader } from "@/components/SiteHeader";
import { Workbench } from "@/components/Workbench";
import r from "@/components/rekindle.module.css";
import { storeFor } from "@/lib/scope";

export const dynamic = "force-dynamic";

/** A stored week: the same ledger, read back from the store (reload shows the same week — D4 gate). */
export default async function PlanPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const store = storeFor({ headers: await headers() });
  const plan = await store.getPlan(id).catch(() => null);
  if (!plan) notFound();
  const c = await store.getCase(plan.case_id).catch(() => null);
  if (!c) notFound();
  // a re-planned week shows the rated week it came from, with the ember threads
  const previous = plan.diff ? await store.getPlan(plan.diff.from_plan_id).catch(() => null) : null;
  return (
    <div className={r.wrap}>
      <SiteHeader />
      <main>
        <Workbench initialCase={c} initialPlan={plan} previousPlan={previous} />
      </main>
    </div>
  );
}
