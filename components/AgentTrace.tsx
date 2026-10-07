"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import s from "./rekindle.module.css";

export interface TraceStats {
  qlooCalls: number;
  llm: string | null;
  seconds: number | null;
  secondsLabel?: string;
  planId: string | null;
}

/** Right rail: the agent's tool calls with result counts and refusals by rule; collapsible below 1100px. */
export function AgentTrace({ lines, stats, live }: { lines: string[]; stats: TraceStats; live: boolean }) {
  const [open, setOpen] = useState(true);
  const ref = useRef<HTMLOListElement>(null);
  useEffect(() => {
    if (window.innerWidth < 1100) setOpen(false);
  }, []);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines.length]);
  return (
    <details className={s.trace} open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)} aria-label="Agent trace" data-testid="trace">
      <summary>Agent trace</summary>
      <ol ref={ref} aria-live={live ? "polite" : "off"}>
        {lines.map((l, i) => (
          <li key={i}>{l}</li>
        ))}
      </ol>
      <div className={s.traceStats}>
        <div>
          Qloo calls <strong data-testid="qloo-count">{stats.qlooCalls}</strong>
        </div>
        {stats.llm && (
          <div>
            routed by <strong>{stats.llm}</strong>
          </div>
        )}
        {stats.seconds !== null && (
          <div>
            {stats.secondsLabel ?? "plan time"} <strong>{stats.seconds.toFixed(1)} s</strong>
          </div>
        )}
        <p>
          <Link className={`${s.link} ${s.linkTarget}`} href={stats.planId ? `/integrations/qloo?plan=${stats.planId}` : "/integrations/qloo"}>
            Every Qloo request behind this week →
          </Link>
        </p>
      </div>
    </details>
  );
}
