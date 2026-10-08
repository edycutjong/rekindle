"use client";
/**
 * The ember moment. Week 1 as rated sits above the week-2 ledger in the same seven columns:
 * activities rated ≥ 7 get the single ember underline, ≤ 3 are struck in graphite. A thin ember thread runs from a rated
 * activity to each week-2 card whose top-weighted RATED Qloo input it is, when that input leads the case's best original love
 * by at least EMBER_MIN_MARGIN (T16), labelled with that lead (Qloo's attribution, not causation). `--after` appears nowhere
 * else in the product, so the colour means "rekindled". Below 720 px the thread becomes the inline label on the card.
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { PlanDoc } from "@/lib/store";
import { DAYS } from "@/lib/verify";
import { DAY_SHORT, leadShown, type EmberLink } from "@/lib/view";
import s from "./rekindle.module.css";

export function ReplanStrip({ prev, threads }: { prev: PlanDoc; threads: EmberLink[] }) {
  const sources = new Set(threads.map((t) => t.from_id));
  return (
    <section className={s.prevWeek} aria-label={`Week ${prev.week} as rated`} data-testid="replan-diff">
      <h2 className={s.prevHead}>
        Week {prev.week} as rated <span>pleasure · mastery</span>
      </h2>
      <div className={s.prevGrid}>
        {DAYS.map((day) => {
          const c = prev.cards.find((x) => x.day_name === day);
          if (!c) return <div key={day} className={s.prevCell} />;
          const lit = c.pleasure !== null && c.pleasure >= 7;
          const low = c.pleasure !== null && c.pleasure <= 3;
          return (
            <div key={day} className={s.prevCell} data-ember-from={sources.has(c.qloo_entity_id) ? c.qloo_entity_id : undefined}>
              <div className={s.prevDay}>{DAY_SHORT[day]}</div>
              <div className={`${s.prevName} ${lit ? s.ember : ""} ${low ? s.prevLow : ""}`} data-testid={lit ? "rekindled" : undefined}>
                {c.name}
              </div>
              <div className={s.prevPm}>
                P {c.pleasure ?? "–"} · M {c.mastery ?? "–"}
                {low && " · excluded"}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** Below the week-2 ledger (so the threads cross nothing): counts, and what left the week with the reason. */
export function ReplanSummary({ prev, diff, threads }: { prev: PlanDoc; diff: NonNullable<PlanDoc["diff"]>; threads: EmberLink[] }) {
  return (
    <section className={s.replanSummary} aria-label="What changed" data-testid="replan-summary">
      <p className={s.diffSummary}>
        Week {prev.week + 1}: {diff.kept.length} kept · {diff.added.length} new · {threads.length} rekindled by a rating <span className={s.reason}>(Qloo&apos;s attribution, not causation)</span>
      </p>
      {diff.kept.filter((k) => k.reason).map((k) => (
        <p key={k.day + k.name} className={s.reason} data-testid="kept-note">
          Kept: <span className={s.ember}>{k.name}</span> — {k.reason}
        </p>
      ))}
      {diff.signals.length > 0 && (
        <div className={s.leaving} data-testid="signal-list">
          <h3>Now a signal for week {prev.week + 1}</h3>
          <ul>
            {diff.signals.map((r) => (
              <li key={r.day + r.name}>
                <span className={s.ember}>{r.name}</span> <span className={s.reason}>{r.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {diff.removed.length > 0 && (
        <div className={s.leaving}>
          <h3>Leaving out</h3>
          <ul>
            {diff.removed.map((r) => (
              <li key={r.day + r.name}>
                <span className={s.prevLow}>{r.name}</span> <span className={s.reason}>{r.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

interface Path {
  d: string;
  x: number;
  y: number;
  anchor: "start" | "end";
  label: string;
  key: string;
}

/**
 * Where a thread drops into its day column: the point of the header's free gap (between the day name and the rung)
 * nearest the card's centre, so the line never crosses "SUN" or "social" at narrow widths. Null when the header has
 * no gap wide enough: the thread then stops at the column's top edge instead of crossing text.
 */
function dropX(col: Element | null, centre: number): number | null {
  const dh = col?.firstElementChild;
  if (!dh) return centre;
  const head = dh.getBoundingClientRect();
  let lo = head.left;
  let hi = head.right;
  const day = dh.firstChild;
  if (day && day.nodeType === Node.TEXT_NODE) {
    const r = document.createRange();
    r.selectNodeContents(day);
    lo = r.getBoundingClientRect().right + 6;
  }
  const rung = dh.querySelector("span");
  if (rung) hi = rung.getBoundingClientRect().left - 6;
  return lo <= hi ? Math.min(Math.max(centre, lo), hi) : null;
}

/**
 * SVG overlay drawn between the rated week and the week-2 ledger inside `children`; decorative (labels are inline).
 * Each thread bends inside the gap above the ledger, lands on the top edge of its day column, and drops straight to the
 * card. Its lead sits in that gap beside the landing point, never on the day header's ink rule (a line through a number
 * reads as a strike, which on this sheet means refused; QA 2026-10-09); a paper halo keeps another thread off it.
 */
export function EmberThreads({ threads, children }: { threads: EmberLink[]; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [paths, setPaths] = useState<Path[]>([]);
  const key = threads.map((t) => t.from_id + t.to_id).join("|");
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const draw = () => {
      if (window.innerWidth < 720) return setPaths([]);
      const box = root.getBoundingClientRect();
      const out: Path[] = [];
      for (const t of threads) {
        const a = root.querySelector(`[data-ember-from="${t.from_id}"]`);
        const b = root.querySelector(`[data-testid=slot-card][data-entity="${t.to_id}"]`);
        if (!a || !b) continue;
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        const col = b.closest("[data-day]");
        const rc = (col ?? b).getBoundingClientRect();
        const centre = rb.left + rb.width / 2;
        const xd = dropX(col, centre);
        const x1 = ra.left + ra.width / 2 - box.left;
        const y1 = ra.bottom - box.top;
        const x2 = (xd ?? centre) - box.left;
        const yc = Math.max(y1, rc.top - box.top); // the day column's top edge: the curve stays in the gap above it
        const y2 = Math.max(yc, rb.top - box.top);
        const my = (y1 + yc) / 2;
        const fromLeft = x1 <= x2; // the label goes on the side away from the incoming curve
        out.push({
          d: `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${yc}${xd === null ? "" : ` L${x2},${y2}`}`,
          x: fromLeft ? x2 + 6 : x2 - 6,
          y: yc - 7,
          anchor: fromLeft ? "start" : "end",
          label: `+${leadShown(t)}`,
          key: t.from_id + t.to_id,
        });
      }
      setPaths(out);
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(root);
    window.addEventListener("resize", draw);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", draw);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return (
    <div ref={ref} className={s.emberWrap}>
      {children}
      {paths.length > 0 && (
        <svg className={s.threads} aria-hidden="true" data-testid="ember-threads">
          {paths.map((p) => (
            <g key={p.key}>
              <path d={p.d} />
              <text x={p.x} y={p.y} textAnchor={p.anchor}>
                {p.label}
              </text>
            </g>
          ))}
        </svg>
      )}
    </div>
  );
}
