"use client";
import type { CaseDoc } from "@/lib/store";
import { CONSTRAINT_FLAGS, DISTANCE_OPTIONS, distanceLabel, lovedTokens, PRICE_OPTIONS, priceLabel } from "@/lib/view";
import type { ConstraintPatch } from "@/lib/service";
import s from "./rekindle.module.css";

const ENERGY = { 1: "low", 2: "some", 3: "good" } as const;

/** Case strip (ui.md 1): the case label, constraint tabs (toggling re-runs only the affected slots) and the loves. */
export function CaseStrip({ c, week, disabled, onToggle, stamp }: { c: CaseDoc; week: number; disabled: boolean; onToggle: (p: ConstraintPatch) => void; stamp?: string | null }) {
  const distances = [...new Set([...DISTANCE_OPTIONS, c.max_meters])].sort((a, b) => a - b);
  return (
    <section className={s.caseStrip} aria-label="Case">
      <div className={s.caseHead}>
        <h1>
          Week {week} · {c.label}
        </h1>
        {c.is_seed && <span className={s.fictional}>fictional case</span>}
        <span className={s.caseMeta}>
          {c.locality || "custom point"} · energy {c.energy} ({ENERGY[c.energy]})
        </span>
        {stamp && (
          <span className={s.stamp} data-testid="stamp">
            {stamp}
          </span>
        )}
      </div>
      <div className={s.tabs} role="group" aria-label="Clinician constraints">
        <span className={s.tabGroupLabel}>constraints</span>
        {CONSTRAINT_FLAGS.map((f) => (
          <button key={f.key} type="button" className={s.tab} aria-pressed={c[f.key]} disabled={disabled} onClick={() => onToggle({ [f.key]: !c[f.key] })} data-testid={`tab-${f.key}`}>
            {f.label}
          </button>
        ))}
        <label className={s.tab}>
          <span className="sr-only">Maximum distance</span>
          <select className={s.tabSelect} value={c.max_meters} disabled={disabled} onChange={(e) => onToggle({ max_meters: Number(e.target.value) })} aria-label="Maximum distance" data-testid="tab-distance">
            {distances.map((m) => (
              <option key={m} value={m}>
                {distanceLabel(m)}
              </option>
            ))}
          </select>
        </label>
        <label className={s.tab}>
          <span className="sr-only">Budget</span>
          <select className={s.tabSelect} value={c.price_max} disabled={disabled} onChange={(e) => onToggle({ price_max: Number(e.target.value) })} aria-label="Budget" data-testid="tab-price">
            {PRICE_OPTIONS.map((p) => (
              <option key={p} value={p}>
                {priceLabel(p)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className={s.loves} aria-label="What the patient loved before the illness">
        <span className={s.tabGroupLabel}>loved</span>
        {lovedTokens(c).map((l) => (
          <span key={l.kind + l.name} className={s.chip}>
            <b>{l.kind} ·</b> {l.name}
          </span>
        ))}
      </div>
    </section>
  );
}
