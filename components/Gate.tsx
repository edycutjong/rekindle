"use client";
/**
 * Clinician gate + ratings controls: per-card approve / swap / remove on a draft week, and the large
 * pleasure / mastery steppers on an approved week. Pure presentation; Workbench owns the requests.
 */
import type { CardAction } from "@/lib/gate";
import { clampScore, type PendingRating } from "@/lib/view";
import s from "./rekindle.module.css";

export interface CardGate {
  mode: "draft" | "rate" | "locked";
  /** this card is being swapped right now */
  busy: boolean;
  /** another request is in flight */
  disabled: boolean;
  approved: boolean;
  onAction: (a: CardAction) => void;
  rating: PendingRating;
  onRate: (r: PendingRating) => void;
}

export function CardActions({ g, name }: { g: CardGate; name: string }) {
  if (g.mode !== "draft") return null;
  return (
    <div className={s.actions} role="group" aria-label={`Clinician actions for ${name}`}>
      <button type="button" className={`${s.act} ${g.approved ? s.actOn : ""}`} aria-pressed={g.approved} disabled={g.disabled} onClick={() => g.onAction(g.approved ? "unapprove" : "approve")} data-testid="card-approve">
        {g.approved ? "approved ✓" : "approve"}
      </button>
      <button type="button" className={s.act} disabled={g.disabled} onClick={() => g.onAction("swap")} data-testid="card-swap" title="Re-run this slot with the same tool and verifier, excluding everything already on the sheet">
        {g.busy ? "swapping…" : "swap"}
      </button>
      <button type="button" className={s.act} disabled={g.disabled} onClick={() => g.onAction("remove")} data-testid="card-remove">
        remove
      </button>
    </div>
  );
}

/** P / M boxes, bottom-right of every card: empty on a draft, steppers once approved, ink numbers once locked. */
export function PMBox({ g }: { g?: CardGate }) {
  if (!g || g.mode === "draft") {
    return (
      <div className={s.pm} aria-label="Pleasure and mastery, rated after the activity">
        <span>P</span>
        <span>M</span>
      </div>
    );
  }
  if (g.mode === "locked") {
    return (
      <div className={s.pm} aria-label="Pleasure and mastery as rated" data-testid="pm-locked">
        <span>
          P <b>{g.rating.pleasure ?? "–"}</b>
        </span>
        <span>
          M <b>{g.rating.mastery ?? "–"}</b>
        </span>
      </div>
    );
  }
  return (
    <div className={s.rate} data-testid="rate">
      <Stepper label="P" long="Pleasure" value={g.rating.pleasure} disabled={g.disabled} onChange={(v) => g.onRate({ ...g.rating, pleasure: v })} />
      <Stepper label="M" long="Mastery" value={g.rating.mastery} disabled={g.disabled} onChange={(v) => g.onRate({ ...g.rating, mastery: v })} />
    </div>
  );
}

function Stepper({ label, long, value, disabled, onChange }: { label: string; long: string; value: number | null; disabled: boolean; onChange: (v: number | null) => void }) {
  const step = (d: number) => onChange(value === null ? 5 : clampScore(value + d));
  return (
    <div className={s.stepper}>
      <span className={s.stepLabel} aria-hidden="true">
        {label}
      </span>
      <button type="button" className={s.stepBtn} disabled={disabled || value === 0} onClick={() => step(-1)} aria-label={`${long} down`}>
        −
      </button>
      <input
        className={s.stepVal}
        type="number"
        inputMode="numeric"
        min={0}
        max={10}
        placeholder="–"
        value={value ?? ""}
        disabled={disabled}
        aria-label={`${long}, 0 to 10`}
        data-testid={`rate-${label.toLowerCase()}`}
        onChange={(e) => onChange(e.target.value === "" ? null : clampScore(Number(e.target.value)))}
      />
      <button type="button" className={s.stepBtn} disabled={disabled || value === 10} onClick={() => step(1)} aria-label={`${long} up`}>
        +
      </button>
    </div>
  );
}
