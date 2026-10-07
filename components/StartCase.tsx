"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import s from "./rekindle.module.css";

/** Clone a fictional seeded case for this visitor, then open it; the plan runs live on the case page. */
export function StartCase({ slug, label, primary = false, fault = false, preset }: { slug: string; label: string; primary?: boolean; fault?: boolean; preset?: "recovery" }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function start() {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/cases/seed/${encodeURIComponent(slug)}${preset ? `?preset=${preset}` : ""}`, { method: "POST" });
      const b = (await r.json()) as { case?: { id: string }; error?: string };
      if (!r.ok || !b.case) throw new Error(b.error ?? `HTTP ${r.status}`);
      router.push(`/cases/${b.case.id}${fault ? "?fault=qloo_unreachable" : ""}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }
  return (
    <>
      <button type="button" className={primary ? s.btn : `${s.btn} ${s.btnQuiet}`} onClick={start} disabled={busy} data-testid={`start-${slug}${fault ? "-outage" : ""}${preset ? `-${preset}` : ""}`}>
        {busy ? "Opening the case…" : label}
      </button>
      {err && (
        <span role="alert" className={s.reason}>
          {" "}
          {err}
        </span>
      )}
    </>
  );
}
