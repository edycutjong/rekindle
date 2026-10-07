import Link from "next/link";
import s from "./rekindle.module.css";

export function SiteHeader() {
  return (
    <header className={s.site}>
      <Link href="/" className={s.brand} aria-label="Rekindle home">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/icon.svg" alt="" width={28} height={28} />
        Rekindle
      </Link>
      <nav className={s.siteNav} aria-label="Site">
        <Link href="/">Cases</Link>
        <Link href="/integrations/qloo">Qloo receipts</Link>
      </nav>
    </header>
  );
}
