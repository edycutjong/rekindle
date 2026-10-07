import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { SiteHeader } from "@/components/SiteHeader";
import { Workbench } from "@/components/Workbench";
import r from "@/components/rekindle.module.css";
import { storeFor } from "@/lib/scope";

export const dynamic = "force-dynamic";

/** A case without a plan yet: the Workbench runs week 1 live on arrival and moves to /plans/:id when it is saved. */
export default async function CasePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ fault?: string }> }) {
  const { id } = await params;
  // `?fault=qloo_unreachable` = the labelled Qloo-outage demo linked from /judge (the server sends no Qloo request)
  const fault = (await searchParams).fault === "qloo_unreachable" ? "qloo_unreachable" : null;
  const c = await storeFor({ headers: await headers() })
    .getCase(id)
    .catch(() => null);
  if (!c) notFound();
  return (
    <div className={r.wrap}>
      <SiteHeader />
      <main>
        <Workbench initialCase={c} initialPlan={null} fault={fault} />
      </main>
    </div>
  );
}
