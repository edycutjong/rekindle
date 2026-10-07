import { notFound } from "next/navigation";
import { SiteHeader } from "@/components/SiteHeader";
import { Workbench } from "@/components/Workbench";
import r from "@/components/rekindle.module.css";
import { storeFromEnv } from "@/lib/store";

export const dynamic = "force-dynamic";

/** A stored week: the same ledger, read back from the store (reload shows the same week — D4 gate). */
export default async function PlanPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const store = storeFromEnv();
  const plan = await store.getPlan(id).catch(() => null);
  if (!plan) notFound();
  const c = await store.getCase(plan.case_id).catch(() => null);
  if (!c) notFound();
  return (
    <div className={r.wrap}>
      <SiteHeader />
      <main>
        <Workbench initialCase={c} initialPlan={plan} />
      </main>
    </div>
  );
}
