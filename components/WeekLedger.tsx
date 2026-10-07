import type { CardDoc } from "@/lib/store";
import type { DayName } from "@/lib/verify";
import { DAY_SHORT, emberLabel, fmtHour, hoursCheck, isOutage, passedChecks, rungLabel, strikeReason, typeLabel, whyParts, type EmberLink, type Strike } from "@/lib/view";
import { CardActions, PMBox, type CardGate } from "./Gate";
import s from "./rekindle.module.css";

export interface DayView {
  day: DayName;
  /** slot hour + rung from the ladder (known from the `start` event or the stored plan) */
  hour: number | null;
  rung: string | null;
  card: CardDoc | null;
  /** a card streamed by a `tool` event before the full plan arrives */
  partial: { name: string; hour: number } | null;
  empty: string | null;
  strikes: Strike[];
  review: CardDoc[];
  /** still waiting for this slot */
  pending: boolean;
  /** an outing being re-checked after a constraint toggle */
  recheck: boolean;
  /** strike keys that appeared in the last toggle (animated once) */
  fresh: Set<string>;
  /** clinician gate / ratings controls for the card (absent while streaming) */
  gate?: CardGate | null;
  /** re-planned week only: the rated week-1 activity that is this card's top-weighted input */
  ember?: EmberLink | null;
}

const VISIBLE_STRIKES = 3;

export function WeekLedger({ days }: { days: DayView[] }) {
  return (
    <section className={s.ledger} aria-label="Week ledger" data-testid="ledger">
      {days.map((d) => (
        <DayColumn key={d.day} d={d} />
      ))}
    </section>
  );
}

function DayColumn({ d }: { d: DayView }) {
  const shown = d.strikes.slice(0, VISIBLE_STRIKES);
  const hidden = d.strikes.slice(VISIBLE_STRIKES);
  return (
    <div className={s.day} data-day={d.day}>
      <div className={s.dh}>
        {DAY_SHORT[d.day]}
        {d.rung && <span>{d.rung}</span>}
      </div>
      {d.card && !d.recheck && !d.gate?.busy ? (
        <SlotCard c={d.card} g={d.gate ?? undefined} ember={d.ember ?? null} />
      ) : d.partial || d.recheck || d.gate?.busy ? (
        <PencilledCard
          name={d.recheck || d.gate?.busy ? (d.card?.name ?? "") : d.partial!.name}
          label={d.gate?.busy ? "swapping: same tool, same verifier" : d.recheck ? "re-checking against the new constraint" : `${d.rung ?? ""} · ${fmtHour(d.partial!.hour)} · verified`}
        />
      ) : d.empty && isOutage(d.empty) ? (
        <div className={`${s.empty} ${s.outage}`} data-testid="qloo-unavailable" role="note">
          <div className={s.rung}>{d.rung ?? "slot"} · Qloo unavailable</div>
          Left empty: no Qloo answer, so nothing was verified. The model never fills a slot on its own.
          <div className={s.reason}>{d.empty}</div>
        </div>
      ) : d.empty ? (
        <div className={s.empty} data-testid="empty-slot">
          <div className={s.rung}>{d.rung ?? "slot"} · left empty</div>
          {d.empty}
        </div>
      ) : d.pending ? (
        <Skeleton />
      ) : null}
      {d.review.map((r) => (
        <div key={r.id} className={s.review} data-testid="review">
          <div className={s.rung}>review · clinician decides</div>
          <div className={s.sname}>{r.name}</div>
          <div className={s.reason}>{r.checks.filter((x) => x.verdict === "REVIEW").map((x) => `${x.rule} · ${x.detail}`).join(" · ")}</div>
        </div>
      ))}
      {shown.map((x) => (
        <StruckCandidate key={x.key} x={x} fresh={d.fresh.has(x.key)} />
      ))}
      {hidden.length > 0 && (
        <details className={s.more}>
          <summary>+ {hidden.length} more refused</summary>
          {hidden.map((x) => (
            <StruckCandidate key={x.key} x={x} fresh={false} />
          ))}
        </details>
      )}
    </div>
  );
}

export function SlotCard({ c, g, ember }: { c: CardDoc; g?: CardGate; ember?: EmberLink | null }) {
  const h = hoursCheck(c);
  const why = whyParts(c.explain_json);
  const checks = passedChecks(c);
  const approved = c.clinician_action === "approved";
  return (
    <article className={`${s.slot} ${s.slotEnter} ${approved ? s.approved : ""}`} data-testid="slot-card" data-entity={c.qloo_entity_id} data-card={c.id} data-approved={approved || undefined}>
      <div className={s.rung}>
        {rungLabel(c)}
        {c.routed_by === "swap" && " · swapped in"}
      </div>
      <h3 className={s.name}>{c.name}</h3>
      <div className={s.etype}>{typeLabel(c.entity_type)}</div>
      {c.coaching && <p className={s.coach}>{c.coaching}</p>}
      <WhyLine parts={why} />
      {ember && (
        <div className={s.emberLabel} data-testid="ember-label">
          {emberLabel(ember)}
        </div>
      )}
      {h && <HoursCheck h={h} geohash={c.rung === "social" ? c.geohash : undefined} />}
      {c.address && <div className={s.addr}>{c.address}</div>}
      {checks.length > 0 && (
        <div className={s.checks} aria-label="Verifier checks passed">
          {checks.map((x) => (
            <abbr key={x.rule} title={x.detail}>
              {x.rule} ✓
            </abbr>
          ))}
        </div>
      )}
      {g && <CardActions g={g} name={c.name} />}
      <PMBox g={g} />
    </article>
  );
}

export function WhyLine({ parts }: { parts: { name: string; weight: string }[] }) {
  if (parts.length === 0) return <div className={s.why}>no explainability returned</div>;
  return (
    <div className={s.why} data-testid="why">
      because{" "}
      {parts.map((p, i) => (
        <span key={p.name}>
          {i > 0 && " · "}
          {p.name} <strong>{p.weight}</strong>
        </span>
      ))}
    </div>
  );
}

export function HoursCheck({ h, geohash }: { h: NonNullable<ReturnType<typeof hoursCheck>>; geohash?: string }) {
  return (
    <div className={s.hrs} data-testid="hours">
      {[h.distance, h.hours].filter(Boolean).join(" · ")}
      {" · "}
      {h.slot} {h.ok ? <span className={s.ok}>✓</span> : "?"}
      {h.moved && <div>{h.moved}</div>}
      {geohash && <div>taste cell {geohash}</div>}
    </div>
  );
}

export function StruckCandidate({ x, fresh }: { x: Strike; fresh: boolean }) {
  return (
    <div className={`${s.struck} ${fresh ? s.struckFresh : ""}`} data-testid="struck" data-rule={x.rule}>
      <div className={s.sname}>{x.name}</div>
      <div className={s.reason} title={x.detail}>
        {strikeReason(x)}
      </div>
    </div>
  );
}

function PencilledCard({ name, label }: { name: string; label: string }) {
  return (
    <div className={`${s.slot} ${s.pencilled} ${s.slotEnter}`} aria-busy="true">
      <div className={s.rung}>{label}</div>
      <div className={s.name}>{name}</div>
      <div className={s.sketch} />
      <div className={s.sketch} />
    </div>
  );
}

function Skeleton() {
  return (
    <div className={s.slot} aria-busy="true" aria-label="Planning this slot">
      <div className={s.sketch} />
      <div className={s.sketch} />
      <div className={s.sketch} />
    </div>
  );
}
