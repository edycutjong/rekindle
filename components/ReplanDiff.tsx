"use client";
/**
 * The ember moment (ui.md 6, design.md §5). Week 1 as rated sits above the week-2 ledger in the same seven columns:
 * activities rated ≥ 7 get the single ember underline, ≤ 3 are struck in graphite. A thin ember thread runs from a rated
 * activity to each week-2 card whose TOP-weighted Qloo input it is, labelled with that weight. `--after` appears nowhere
 * else in the product, so the colour means "rekindled". Below 720 px the thread becomes the inline label on the card.
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { PlanDoc } from "@/lib/store";
import { DAYS } from "@/lib/verify";
import { DAY_SHORT, type EmberLink } from "@/lib/view";
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
        Week {prev.week + 1}: {diff.kept.length} kept · {diff.added.length} new · {threads.length} rekindled by a rating
      </p>
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
  label: string;
  key: string;
}

/** SVG overlay drawn between the rated week and the week-2 ledger inside `children`; decorative (labels are inline). */
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
        const x1 = ra.left + ra.width / 2 - box.left;
        const y1 = ra.bottom - box.top;
        const x2 = rb.left + rb.width / 2 - box.left;
        const y2 = rb.top - box.top;
        const my = (y1 + y2) / 2;
        out.push({ d: `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`, x: x2 + 4, y: y2 - 6, label: t.score.toFixed(2), key: t.from_id + t.to_id });
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
              <text x={p.x} y={p.y}>
                {p.label}
              </text>
            </g>
          ))}
        </svg>
      )}
    </div>
  );
}
