import { SiteHeader } from "@/components/SiteHeader";
import { StartCase } from "@/components/StartCase";
import { SEEDS } from "@/lib/service";
import { distanceLabel, priceLabel } from "@/lib/view";
import s from "./home.module.css";
import r from "@/components/rekindle.module.css";

export const dynamic = "force-static";

const flags = (p: (typeof SEEDS)[number]) => [p.in_recovery && "in recovery", p.need_quiet && "quiet", p.need_wheelchair && "wheelchair"].filter(Boolean).join(" · ");

export default function Home() {
  const maya = SEEDS.find((p) => p.slug === "maya")!;
  const others = SEEDS.filter((p) => p.slug !== "maya");
  return (
    <div className={r.wrap}>
      <SiteHeader />
      <main className={s.home}>
        <section className={s.intro}>
          <h1 className={s.title}>A week of things she used to love, checked before it reaches her.</h1>
          <p className={s.lead}>
            Rekindle is a planning agent for clinicians. From what a patient loved before the illness, it builds a graded week of real activities with Qloo: each
            one explained by those loves, and every outing checked open at its slot, near, within budget and allowed. Refused candidates stay on the sheet,
            struck through with the rule that refused them.
          </p>
        </section>

        <section className={s.caseFile} aria-labelledby="maya">
          <div className={s.caseTop}>
            <h2 id="maya" className={s.caseName}>
              {maya.label}
            </h2>
            <span className={r.fictional}>fictional case</span>
          </div>
          <p className={s.hook}>Six months flat. She can&apos;t name one thing she&apos;d enjoy this week.</p>
          <dl className={s.facts}>
            <div>
              <dt>where</dt>
              <dd>{maya.locality}</dd>
            </div>
            <div>
              <dt>energy</dt>
              <dd>{maya.energy} of 3</dd>
            </div>
            <div>
              <dt>limits</dt>
              <dd>
                {distanceLabel(maya.radius_m)} · {priceLabel(maya.price_max)}
              </dd>
            </div>
            <div>
              <dt>loved</dt>
              <dd>{maya.loves.map((l) => l.name ?? l.text).join(" · ")}</dd>
            </div>
          </dl>
          <div className={s.cta}>
            <StartCase slug="maya" label="Plan Maya's week, live" primary />
            <span className={s.ctaNote}>Calls Qloo and the routing model live and streams the week as it is built. Then switch on “In recovery”.</span>
          </div>
        </section>

        <section aria-labelledby="others">
          <h2 id="others" className={s.h2}>
            Other fictional cases
          </h2>
          <ul className={s.cases}>
            {others.map((p) => (
              <li key={p.slug} className={s.caseRow}>
                <div>
                  <strong>{p.label}</strong> <span className={s.muted}>{p.locality}</span>
                  <div className={s.rowMeta}>
                    energy {p.energy} · {distanceLabel(p.radius_m)} · {priceLabel(p.price_max)}
                    {flags(p) ? ` · ${flags(p)}` : ""} · {p.loves.map((l) => l.name ?? l.text).join(", ")}
                  </div>
                </div>
                <StartCase slug={p.slug} label="Plan" />
              </li>
            ))}
          </ul>
        </section>

        <p className={s.footnote}>
          Clinician-support only: no diagnosis, no efficacy claims, nothing reaches a patient without a clinician. Every profile here is fictional; only taste
          entities and a map point are sent to Qloo, never health data.
        </p>
      </main>
    </div>
  );
}
