"use client";
/**
 * The product screen: case strip + week ledger + agent trace. With no plan yet it runs week 1 live
 * (POST /api/cases/:id/plan, Server-Sent Events) and fills the ledger as tool events arrive; the stored plan replaces
 * the streamed sketch when the `plan` event lands, and the URL becomes /plans/:id so a reload shows the same week.
 */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ConstraintPatch } from "@/lib/service";
import type { CaseDoc, PlanDoc } from "@/lib/store";
import { DAYS, type DayName } from "@/lib/verify";
import { strikesByDay, traceFromPlan, traceLine } from "@/lib/view";
import { AgentTrace } from "./AgentTrace";
import { CaseStrip } from "./CaseStrip";
import s from "./rekindle.module.css";
import { WeekLedger, type DayView } from "./WeekLedger";

type Ev = { type: string } & Record<string, unknown>;

interface Streamed {
  slots: Partial<Record<DayName, { hour: number; rung: string }>>;
  cards: Partial<Record<DayName, { name: string; hour: number }>>;
  empty: Partial<Record<DayName, string>>;
}

interface Failure {
  message: string;
  status?: number;
}

/** incremental SSE reader over a fetch body */
async function readSse(res: Response, on: (event: string, data: unknown) => void) {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const event = /^event: (.*)$/m.exec(frame)?.[1] ?? "message";
      const data = /^data: (.*)$/m.exec(frame)?.[1];
      on(event, data ? JSON.parse(data) : null);
    }
  }
}

export function Workbench({ initialCase, initialPlan }: { initialCase: CaseDoc; initialPlan: PlanDoc | null }) {
  const [c, setCase] = useState(initialCase);
  const [plan, setPlan] = useState<PlanDoc | null>(initialPlan);
  const [phase, setPhase] = useState<"streaming" | "idle" | "toggling">(initialPlan ? "idle" : "streaming");
  const [streamed, setStreamed] = useState<Streamed>({ slots: {}, cards: {}, empty: {} });
  const [live, setLive] = useState<string[]>([]);
  const [qloo, setQloo] = useState(0);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const started = useRef(false);

  const run = useCallback(async () => {
    setPhase("streaming");
    setFailure(null);
    setLive([]);
    setQloo(0);
    setStreamed({ slots: {}, cards: {}, empty: {} });
    try {
      const res = await fetch(`/api/cases/${c.id}/plan`, { method: "POST" });
      if (!res.ok || !res.body) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        throw Object.assign(new Error(b.error ?? `HTTP ${res.status}`), { status: res.status });
      }
      let got = false;
      await readSse(res, (event, data) => {
        const e = data as Ev;
        if (event === "qloo") return setQloo((n) => n + 1);
        if (event === "plan") {
          got = true;
          const p = (data as { plan: PlanDoc }).plan;
          setPlan(p);
          window.history.replaceState(null, "", `/plans/${p.id}`);
          return;
        }
        if (event === "error") throw Object.assign(new Error((data as { error?: string }).error ?? "the plan failed"), { status: (data as { status?: number }).status });
        if (event === "start") {
          const slots: Streamed["slots"] = {};
          for (const x of e.slots as { day: DayName; hour: number; rung: string }[]) slots[x.day] = { hour: x.hour, rung: x.rung };
          setStreamed((st) => ({ ...st, slots }));
        }
        if (event === "tool") {
          const day = e.day as DayName;
          const card = e.card as { name: string; hour: number } | null;
          setStreamed((st) => (card ? { ...st, cards: { ...st.cards, [day]: { name: card.name, hour: card.hour } } } : { ...st, empty: { ...st.empty, [day]: String(e.empty ?? "no verified candidate") } }));
        }
        const line = traceLine({ ...e, type: event });
        if (line) setLive((l) => [...l, line]);
      });
      if (!got) throw new Error("the stream ended before the plan was saved");
    } catch (err) {
      setFailure({ message: err instanceof Error ? err.message : String(err), status: (err as { status?: number }).status });
    } finally {
      setPhase("idle");
    }
  }, [c.id]);

  useEffect(() => {
    if (initialPlan || started.current) return;
    started.current = true;
    void run();
  }, [initialPlan, run]);

  const toggle = useCallback(
    async (patch: ConstraintPatch) => {
      if (!plan) return;
      setPhase("toggling");
      setFailure(null);
      setNotice(null);
      const before = new Set(plan.refusals.map((r) => `${r.day_name}|${r.qloo_entity_id}|${r.rule}`));
      try {
        const res = await fetch(`/api/plans/${plan.id}/constraints`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) });
        const b = (await res.json()) as { plan?: PlanDoc; case?: CaseDoc; error?: string };
        if (!res.ok || !b.plan || !b.case) throw Object.assign(new Error(b.error ?? `HTTP ${res.status}`), { status: res.status });
        setCase(b.case);
        setPlan(b.plan);
        setFresh(new Set(b.plan.refusals.filter((r) => !before.has(`${r.day_name}|${r.qloo_entity_id}|${r.rule}`)).map((r) => `${r.day_name}|${r.qloo_entity_id}|${r.rule}`)));
        if (b.plan.id !== plan.id) window.history.replaceState(null, "", `/plans/${b.plan.id}`);
        const t = b.plan.toggle;
        const next = b.plan;
        if (t && next.id !== plan.id) setLive((l) => [...(l.length ? l : traceFromPlan(plan)), ...traceFromPlan(next).slice(0, 1)]);
        setNotice(
          b.plan.id === plan.id || !t
            ? "No change to the week."
            : t.struck === 0
              ? `Every placed outing still passes the new constraint (${(t.ms / 1000).toFixed(1)} s). Loosening keeps the verified week; re-plan to use the wider setting.`
              : `${t.struck} outing${t.struck === 1 ? "" : "s"} struck in place and ${t.refilled} slot${t.refilled === 1 ? "" : "s"} refilled live · ${(t.ms / 1000).toFixed(1)} s`,
        );
      } catch (err) {
        setFailure({ message: err instanceof Error ? err.message : String(err), status: (err as { status?: number }).status });
      } finally {
        setPhase("idle");
      }
    },
    [plan],
  );

  const days: DayView[] = useMemo(() => {
    const strikes = plan ? strikesByDay(plan) : null;
    return DAYS.map((day) => {
      const card = plan?.cards.find((x) => x.day_name === day) ?? null;
      const empty = plan?.empty_slots.find((x) => x.day_name === day) ?? null;
      const slot = card ? { hour: card.slot_hour, rung: card.rung } : empty ? { hour: empty.hour, rung: empty.rung } : (streamed.slots[day] ?? null);
      return {
        day,
        hour: slot?.hour ?? null,
        rung: slot?.rung ?? null,
        card,
        partial: plan ? null : (streamed.cards[day] ?? null),
        empty: plan ? (empty?.reason ?? null) : (streamed.empty[day] ?? null),
        strikes: strikes?.[day] ?? [],
        review: plan?.review.filter((r) => r.day_name === day) ?? [],
        pending: !plan && phase === "streaming",
        recheck: phase === "toggling" && !!card && card.rung !== "home",
        fresh,
      };
    });
  }, [plan, streamed, phase, fresh]);

  const traceLines = plan && live.length === 0 ? traceFromPlan(plan) : live;
  const stats = {
    qlooCalls: plan ? plan.qloo_calls : qloo,
    llm: plan ? (plan.llm_model ? `${plan.llm_provider}:${plan.llm_model}` : "deterministic route") : null,
    seconds: plan ? plan.latency_ms / 1000 : null,
    secondsLabel: plan?.origin === "toggle" ? "last update" : "plan time",
    planId: plan?.id ?? null,
  };

  return (
    <>
      <CaseStrip c={c} week={plan?.week ?? 1} disabled={phase !== "idle" || !plan || plan.status !== "draft"} onToggle={toggle} />
      {phase === "streaming" && (
        <p className={s.notice} role="status">
          Planning live: the agent routes each slot, Qloo returns candidates, the verifier strikes what fails.
        </p>
      )}
      {phase === "toggling" && (
        <p className={s.notice} role="status">
          Re-checking the placed outings against the new constraint…
        </p>
      )}
      {notice && phase === "idle" && (
        <p className={s.notice} role="status" data-testid="toggle-notice">
          {notice}
        </p>
      )}
      {failure && (
        <div className={s.errorBox} role="alert">
          <p>
            <strong>{failure.status === 429 ? "Capacity reached." : "The plan could not finish."}</strong> {failure.message}
          </p>
          <p>
            No week is invented when this happens. <Link className={s.link} href="/integrations/qloo">See the receipts of the latest live runs</Link>
            {!plan && failure.status !== 429 && (
              <>
                {" "}
                or{" "}
                <button type="button" className={`${s.btn} ${s.btnQuiet}`} onClick={() => void run()}>
                  try again
                </button>
              </>
            )}
          </p>
        </div>
      )}
      <div className={s.grid}>
        <WeekLedger days={days} />
        <AgentTrace lines={traceLines} stats={stats} live={phase === "streaming"} />
      </div>
      <div className={s.bar}>
        <span>Draft week for clinician review. Fictional case: never enter a real patient&apos;s name.</span>
        {plan && <span className={s.reason}>plan {plan.id.slice(0, 8)} · {plan.origin === "toggle" ? "constraint change" : "agent run"} · {new Date(plan.created_at).toUTCString().slice(5, 22)} UTC</span>}
      </div>
    </>
  );
}
