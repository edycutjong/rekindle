import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { SiteHeader } from "@/components/SiteHeader";
import { Workbench } from "@/components/Workbench";
import r from "@/components/rekindle.module.css";
import { canWrite } from "@/lib/owner";
import { readCase } from "@/lib/reads";
import { storeFor } from "@/lib/scope";
import { latestVersion, planRunState } from "@/lib/service";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const c = await readCase(id);
  return { title: c ? `Week 1 · ${c.label} · Rekindle` : "Not found · Rekindle", robots: { index: false } };
}

/**
 * A case without a plan yet: the Workbench runs week 1 live on arrival and moves to /plans/:id when it is saved. A case
 * whose week 1 exists redirects there; one whose run is still in flight is waited on (the route answers 409).
 */
export default async function CasePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ fault?: string }> }) {
  const { id } = await params;
  // `?fault=qloo_unreachable` = the labelled Qloo-outage demo linked from /judge (the server sends no Qloo request)
  const fault = (await searchParams).fault === "qloo_unreachable" ? "qloo_unreachable" : null;
  const h = await headers();
  const store = storeFor({ headers: h });
  const c = await readCase(id);
  if (!c) notFound();
  // week 1 already saved for this case (a reopened link, a reload after the run): show it, never run it again
  const state = await planRunState(store, id);
  // (its newest version, when a constraint toggle replaced it)
  if (state && "plan" in state) redirect(`/plans/${(await latestVersion(store, state.plan)).id}`);
  return (
    <div className={r.wrap}>
      <SiteHeader />
      <main>
        <Workbench initialCase={c} initialPlan={null} fault={fault} canEdit={canWrite({ headers: h }, c)} />
      </main>
    </div>
  );
}
