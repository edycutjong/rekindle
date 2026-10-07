import Link from "next/link";
import { SiteHeader } from "@/components/SiteHeader";
import r from "@/components/rekindle.module.css";
import s from "./home.module.css";

/** Unknown plan, case or route: the site header and a way back, in the paper style (never Next's bare 404). */
export default function NotFound() {
  return (
    <div className={r.wrap}>
      <SiteHeader />
      <main className={s.home}>
        <section className={s.intro}>
          <h1 className={s.title}>This week isn&apos;t on file.</h1>
          <p className={s.lead}>
            Plans and cases are kept per deployment, and every case here is fictional, so an old link can point at a week that no longer exists. Start a new
            fictional case, or look at the receipts.
          </p>
          <p className={s.lead}>
            <Link className={r.link} href="/" data-testid="nf-home">
              Plan a fictional case
            </Link>{" "}
            ·{" "}
            <Link className={r.link} href="/judge" data-testid="nf-judge">
              Judge receipts
            </Link>
          </p>
        </section>
      </main>
    </div>
  );
}
