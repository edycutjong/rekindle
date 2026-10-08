import Link from "next/link";
import { SiteHeader } from "@/components/SiteHeader";
import r from "@/components/rekindle.module.css";
import s from "@/app/home.module.css";

/** a2a r06: what a saved-week page renders when storage refuses — never the "isn't on file" 404 */
export const UNAVAILABLE_TITLE = "Unavailable right now · Rekindle";

/**
 * The store did not answer (safe mode): the week may well exist, so the page says so instead of "Not found", and
 * points at the one thing that still works, a new live plan.
 */
export function PageUnavailable({ what = "This saved week" }: { what?: string }) {
  return (
    <div className={r.wrap}>
      <SiteHeader />
      <main className={s.home}>
        <section className={s.intro} data-testid="store-unavailable">
          <h1 className={s.title}>{what} is unavailable right now.</h1>
          <p className={s.lead}>
            Storage is not answering, so saved weeks cannot be read at the moment. Try this link again in a few minutes. Planning a new fictional week still
            runs live against Qloo and the model.
          </p>
          <p className={s.lead}>
            <Link className={r.link} href="/">
              Plan a fictional case
            </Link>{" "}
            ·{" "}
            <Link className={r.link} href="/judge">
              Judge receipts
            </Link>
          </p>
        </section>
      </main>
    </div>
  );
}
