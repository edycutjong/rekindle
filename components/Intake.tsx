"use client";
/**
 * Intake (spec Core Feature 1, step 1 of the one flow): the clinician types 3–6 things the patient loved before the
 * illness; each is resolved live to a Qloo ID (GET /api/resolve → Qloo /search pinned to a type, or /v2/tags for food
 * and activities) and confirmed by the clinician from the top 3 — nothing is guessed. Then a neighbourhood point,
 * energy, budget and the three constraints, and POST /api/cases → /cases/:id, where week 1 runs live.
 * Fictional cases only: the label is a first name the clinician invents.
 */
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { screenLoveText, type LoveCandidate, type LoveKind } from "@/lib/resolve";
import { CONSTRAINT_FLAGS, priceLabel, tagKind } from "@/lib/view";
import s from "./rekindle.module.css";
import i from "./intake.module.css";

export interface IntakePoint {
  locality: string;
  lon: number;
  lat: number;
}

const KINDS: { kind: LoveKind; label: string }[] = [
  { kind: "artist", label: "musician" },
  { kind: "tv_show", label: "TV show" },
  { kind: "movie", label: "film" },
  { kind: "book", label: "book" },
  { kind: "podcast", label: "podcast" },
  { kind: "place_tag", label: "food / place" },
  { kind: "activity_tag", label: "activity" },
];

interface LoveRow {
  key: number;
  text: string;
  kind: LoveKind;
  candidates: LoveCandidate[] | null;
  status: "idle" | "looking" | "error";
  error?: string;
  picked: LoveCandidate | null;
}

const MIN_LOVES = 3;
const MAX_LOVES = 6;
let nextKey = 1;
const blank = (kind: LoveKind = "artist"): LoveRow => ({ key: nextKey++, text: "", kind, candidates: null, status: "idle", picked: null });

export function IntakeForm({ points }: { points: IntakePoint[] }) {
  const router = useRouter();
  const [label, setLabel] = useState("");
  const [rows, setRows] = useState<LoveRow[]>(() => [blank("artist"), blank("tv_show"), blank("place_tag")]);
  const [point, setPoint] = useState(0);
  const [energy, setEnergy] = useState<1 | 2 | 3>(1);
  const [price, setPrice] = useState(2);
  const [flags, setFlags] = useState({ in_recovery: false, need_quiet: false, need_wheelchair: false });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const t = timers.current;
    return () => t.forEach((x) => clearTimeout(x));
  }, []);

  const update = (key: number, patch: Partial<LoveRow>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  /** debounced live lookup: Qloo /search (entities) or /v2/tags (food, activities) through /api/resolve */
  const lookup = (key: number, text: string, kind: LoveKind) => {
    const t = timers.current.get(key);
    if (t) clearTimeout(t);
    if (text.trim().length < 2) return update(key, { candidates: null, status: "idle" });
    // the same deny list the server applies: health details or contact data are never looked up
    const refused = screenLoveText(text.trim());
    if (refused) return update(key, { candidates: null, status: "error", error: refused });
    timers.current.set(
      key,
      setTimeout(async () => {
        update(key, { status: "looking" });
        try {
          const r = await fetch(`/api/resolve?text=${encodeURIComponent(text.trim())}&kind=${kind}`);
          const b = (await r.json()) as { candidates?: LoveCandidate[]; error?: string; issues?: { message: string }[] };
          if (!r.ok) throw new Error(b.issues?.[0]?.message ?? b.error ?? `HTTP ${r.status}`);
          setRows((rs) => rs.map((x) => (x.key === key && x.text === text && x.kind === kind ? { ...x, candidates: b.candidates ?? [], status: "idle" } : x)));
        } catch (e) {
          update(key, { status: "error", error: e instanceof Error ? e.message : String(e) });
        }
      }, 650),
    );
  };

  const confirmed = rows.filter((r) => r.picked);
  const ready = label.trim().length > 0 && confirmed.length >= MIN_LOVES && confirmed.length <= MAX_LOVES && !busy;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setErr(null);
    const p = points[point];
    try {
      const r = await fetch("/api/cases", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          label: label.trim(),
          locality: p.locality,
          lon: p.lon,
          lat: p.lat,
          energy,
          price_max: price,
          ...flags,
          loves: confirmed.map((x) => ({ text: x.text.trim() || x.picked!.name, qloo_id: x.picked!.qloo_id, qloo_kind: x.picked!.qloo_kind, ...(x.picked!.entity_type ? { entity_type: x.picked!.entity_type } : {}), name: x.picked!.name })),
        }),
      });
      const b = (await r.json()) as { case?: { id: string }; error?: string; issues?: { path: string; message: string }[] };
      if (!r.ok || !b.case) throw new Error(b.issues?.length ? b.issues.map((x) => `${x.path}: ${x.message}`).join("; ") : (b.error ?? `HTTP ${r.status}`));
      router.push(`/cases/${b.case.id}`);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : String(e2));
      setBusy(false);
    }
  }

  return (
    <form className={i.form} onSubmit={submit} data-testid="intake">
      <fieldset className={i.group}>
        <legend>Fictional first name</legend>
        <input className={i.input} value={label} maxLength={40} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Rosa" data-testid="intake-label" aria-describedby="name-note" />
        <p id="name-note" className={s.reason}>
          Invent one; it stays on this server. Never enter a real patient&apos;s name. What you type into a love box below is sent to Qloo to find matches, so type only the taste.
        </p>
      </fieldset>

      <fieldset className={i.group}>
        <legend>
          What she loved before ({confirmed.length} of {MIN_LOVES}–{MAX_LOVES} confirmed)
        </legend>
        <p className={s.reason}>
          Type a name, pick what kind it is, then confirm one of Qloo&apos;s matches. Nothing is guessed: an unconfirmed row is left out. The text in each box is sent to Qloo
          /search or /v2/tags to find matches: type only the taste (an artist, a show, a food), never health details or names.
        </p>
        {rows.map((r, n) => (
          <div key={r.key} className={i.love} data-testid="intake-love">
            <div className={i.loveRow}>
              <select
                className={i.select}
                value={r.kind}
                aria-label={`Kind of love ${n + 1}`}
                onChange={(e) => {
                  const kind = e.target.value as LoveKind;
                  update(r.key, { kind, picked: null, candidates: null });
                  lookup(r.key, r.text, kind);
                }}
              >
                {KINDS.map((k) => (
                  <option key={k.kind} value={k.kind}>
                    {k.label}
                  </option>
                ))}
              </select>
              <input
                className={i.input}
                value={r.text}
                maxLength={120}
                aria-label={`Love ${n + 1}`}
                placeholder={n === 0 ? "e.g. Phoebe Bridgers" : n === 1 ? "e.g. Fleabag" : n === 2 ? "e.g. ramen" : ""}
                onChange={(e) => {
                  update(r.key, { text: e.target.value, picked: null });
                  lookup(r.key, e.target.value, r.kind);
                }}
                data-testid="intake-love-text"
              />
              {rows.length > MIN_LOVES && (
                <button type="button" className={`${s.btn} ${s.btnQuiet}`} onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))} aria-label={`Remove love ${n + 1}`}>
                  remove
                </button>
              )}
            </div>
            <div className={i.chips} aria-live="polite">
              {r.status === "looking" && <span className={s.reason}>asking Qloo…</span>}
              {r.status === "error" && <span className={s.reason}>lookup failed: {r.error}</span>}
              {r.status === "idle" && r.candidates?.length === 0 && <span className={s.reason}>Qloo returned no match for this kind; try another spelling or kind.</span>}
              {r.candidates?.map((c) => (
                <button
                  type="button"
                  key={c.qloo_id}
                  className={`${i.chip} ${r.picked?.qloo_id === c.qloo_id ? i.chipOn : ""}`}
                  aria-pressed={r.picked?.qloo_id === c.qloo_id}
                  onClick={() => update(r.key, { picked: r.picked?.qloo_id === c.qloo_id ? null : c })}
                  data-testid="love-chip"
                >
                  <span className={i.chipKind}>{c.qloo_kind === "tag" ? tagKind(c.qloo_id, r.candidates?.map((x) => x.qloo_id)) : (KINDS.find((k) => k.kind === r.kind)?.label ?? r.kind)}</span> {c.name}
                </button>
              ))}
            </div>
          </div>
        ))}
        {rows.length < MAX_LOVES && (
          <button type="button" className={`${s.btn} ${s.btnQuiet}`} onClick={() => setRows((rs) => [...rs, blank("book")])}>
            add another love
          </button>
        )}
      </fieldset>

      <fieldset className={i.group}>
        <legend>Where and how much</legend>
        <div className={i.grid}>
          <label>
            <span>Neighbourhood (map point sent to Qloo)</span>
            <select className={i.select} value={point} onChange={(e) => setPoint(Number(e.target.value))} data-testid="intake-point">
              {points.map((p, n) => (
                <option key={p.locality} value={n}>
                  {p.locality}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Energy this week</span>
            <select className={i.select} value={energy} onChange={(e) => setEnergy(Number(e.target.value) as 1 | 2 | 3)}>
              <option value={1}>1 of 3 — mostly at home</option>
              <option value={2}>2 of 3</option>
              <option value={3}>3 of 3 — most days out</option>
            </select>
          </label>
          <label>
            <span>Budget per outing</span>
            <select className={i.select} value={price} onChange={(e) => setPrice(Number(e.target.value))}>
              {[1, 2, 3, 4].map((n) => (
                <option key={n} value={n}>
                  {priceLabel(n)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className={i.flags}>
          {CONSTRAINT_FLAGS.map((f) => (
            <label key={f.key} className={i.flag}>
              <input type="checkbox" checked={flags[f.key]} onChange={(e) => setFlags((x) => ({ ...x, [f.key]: e.target.checked }))} /> {f.label}
            </label>
          ))}
        </div>
        <p className={s.reason}>Walking radius follows energy (1.5 / 3 / 5 km); the clinician can tighten or widen it on the sheet.</p>
      </fieldset>

      <div className={i.submit}>
        <button type="submit" className={s.btn} disabled={!ready} data-testid="intake-submit">
          {busy ? "Saving the case…" : "Save the case and plan week 1, live"}
        </button>
        {!ready && !busy && (
          <span className={s.reason}>
            {label.trim() ? "" : "Add a fictional first name. "}
            {confirmed.length < MIN_LOVES ? `Confirm ${MIN_LOVES - confirmed.length} more love${MIN_LOVES - confirmed.length === 1 ? "" : "s"}.` : ""}
          </span>
        )}
        {err && (
          <span role="alert" className={s.reason}>
            {" "}
            {err}
          </span>
        )}
      </div>
    </form>
  );
}
