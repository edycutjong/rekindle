import type { Metadata } from "next";
import { IntakeForm, type IntakePoint } from "@/components/Intake";
import { SiteHeader } from "@/components/SiteHeader";
import r from "@/components/rekindle.module.css";
import { SEEDS } from "@/lib/service";
import s from "../../home.module.css";

export const dynamic = "force-static";
export const metadata: Metadata = { title: "New fictional case · Rekindle" };

/** Neighbourhood points the intake offers: the seeded profiles' map points (fictional cases only; no street addresses). */
const POINTS: IntakePoint[] = [...new Map(SEEDS.map((p) => [p.locality, { locality: p.locality, lon: p.lon, lat: p.lat }])).values()].sort((a, b) => a.locality.localeCompare(b.locality));

export default function NewCase() {
  return (
    <div className={r.wrap}>
      <SiteHeader />
      <main className={s.home}>
        <section className={s.intro}>
          <h1 className={s.title}>A new fictional case</h1>
          <p className={s.lead}>
            Intake is step one: three to six things the patient loved before the illness, each confirmed against Qloo, then where she lives and what this week
            can hold. Saving the case starts week 1, live.
          </p>
        </section>
        <IntakeForm points={POINTS} />
      </main>
    </div>
  );
}
