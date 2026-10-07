"use client";
/**
 * The product screen: case strip + week ledger + agent trace. With no plan yet it runs week 1 live
 * (POST /api/cases/:id/plan, Server-Sent Events) and fills the ledger as tool events arrive; the stored plan replaces
 * the streamed sketch when the `plan` event lands, and the URL becomes /plans/:id so a reload shows the same week.
 */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CardAction } from "@/lib/gate";
import type { ConstraintPatch } from "@/lib/service";
import type { CaseDoc, PlanDoc } from "@/lib/store";
import { DAYS, type DayName } from "@/lib/verify";
import { changedRatings, coverageRefusal, distanceLabel, emberThreads, outageState, ratedCount, reviewsByDay, stampLabel, strikesByDay, swapNotice, toggleNotice, traceFromPlan, traceLine, type PendingRating } from "@/lib/view";
import { AgentTrace } from "./AgentTrace";
import { CaseStrip } from "./CaseStrip";
import { EmberThreads, ReplanStrip, ReplanSummary } from "./ReplanDiff";
import s from "./rekindle.module.css";
import { WeekLedger, type DayView } from "./WeekLedger";

/** the re-plan button is enabled at this many rated activities (ui.md 5; lib/gate.ts MIN_RATED_FOR_REPLAN) */
const MIN_RATED = 3;

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

export function Workbench({ initialCase, initialPlan, previousPlan = null, fault = null }: { initialCase: CaseDoc; initialPlan: PlanDoc | null; previousPlan?: PlanDoc | null; fault?: "qloo_unreachable" | null }) {
  const [c, setCase] = useState(initialCase);
  const [plan, setPlan] = useState<PlanDoc | null>(initialPlan);
  /** the rated week this one was re-planned from (shown above the ledger with the ember threads) */
  const [prev, setPrev] = useState<PlanDoc | null>(previousPlan);
  const [phase, setPhase] = useState<"streaming" | "idle" | "toggling" | "acting">(initialPlan ? "idle" : "streaming");
  const [swapping, setSwapping] = useState<string | null>(null);
  const [pending, setPending] = useState<Record<string, PendingRating>>({});
  const [streamed, setStreamed] = useState<Streamed>({ slots: {}, cards: {}, empty: {} });
  const [live, setLive] = useState<string[]>([]);
  const [qloo, setQloo] = useState(0);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const started = useRef(false);

  /** Stream an agent run into the ledger: week 1 for the case, or week N+1 re-planned from a rated week. */
  const run = useCallback(async (rated?: PlanDoc) => {
    setPhase("streaming");
    setFailure(null);
    setNotice(null);
    setLive([]);
    setQloo(0);
    setStreamed({ slots: {}, cards: {}, empty: {} });
    if (rated) {
      setPrev(rated);
      setPlan(null);
    }
    try {
      const post = () =>
        fetch(
          rated ? `/api/plans/${rated.id}/replan` : `/api/cases/${c.id}/plan`,
          // the labelled outage demo (/judge) asks the server to run with an unreachable Qloo client; never on a re-plan
          !rated && fault ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fault }) } : { method: "POST" },
        );
      let res = await post();
      // a reload during the run: the first run is still in flight server side (409 running) — wait for its stored week
      // instead of starting another agent run; each check is answered before the rate limiter
      for (let i = 0; !rated && res.status === 409 && i < 30; i++) {
        const b = (await res.clone().json().catch(() => ({}))) as { running?: boolean };
        if (!b.running) break;
        if (i === 0) setLive(["this case is already being planned (a reload or another tab) — waiting for that run's saved week, no second run"]);
        await new Promise((r) => setTimeout(r, 3000));
        res = await post();
      }
      if (!res.ok || !res.body) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        throw Object.assign(new Error(b.error ?? `HTTP ${res.status}`), { status: res.status });
      }
      let got = false;
      if (res.headers.get("content-type")?.includes("application/json")) {
        // a week that was already re-planned comes back whole (no second agent run)
        const p = ((await res.json()) as { plan: PlanDoc }).plan;
        setPlan(p);
        window.history.replaceState(null, "", `/plans/${p.id}`);
        return;
      }
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
      if (rated) {
        // nothing was re-planned: put the rated week back on the sheet
        setPlan(rated);
        setPrev(null);
      }
    } finally {
      setPhase("idle");
    }
  }, [c.id, fault]);

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
        setNotice(toggleNotice(plan, c, b.plan, b.case));
      } catch (err) {
        setFailure({ message: err instanceof Error ? err.message : String(err), status: (err as { status?: number }).status });
      } finally {
        setPhase("idle");
      }
    },
    [plan, c],
  );

  /** one JSON request that returns `{ plan }`; errors land in the failure box */
  const send = useCallback(async (url: string, method: string, body?: unknown) => {
    const res = await fetch(url, { method, ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
    const b = (await res.json().catch(() => ({}))) as { plan?: PlanDoc; error?: string; swap?: { found: boolean; ms: number; calls: number } };
    if (!res.ok || !b.plan) throw Object.assign(new Error(b.error ?? `HTTP ${res.status}`), { status: res.status });
    return b as { plan: PlanDoc; swap?: { found: boolean; ms: number; calls: number } };
  }, []);

  const act = useCallback(
    async (cardId: string, action: CardAction) => {
      if (!plan) return;
      const before = plan.cards.find((x) => x.id === cardId);
      setPhase("acting");
      setFailure(null);
      setNotice(null);
      if (action === "swap") setSwapping(cardId);
      try {
        const r = await send(`/api/plans/${plan.id}/cards/${cardId}`, "PATCH", { action });
        setPlan(r.plan);
        const sw = r.swap;
        if (action === "swap" && sw && before) {
          setNotice(swapNotice(before, r.plan, sw));
          const now = r.plan.cards.find((x) => x.day_name === before.day_name)?.name ?? "empty";
          setLive((l) => [...(l.length ? l : traceFromPlan(plan)), `swap ${before.day_name} ${before.name} → ${now} · ${sw.calls} Qloo call${sw.calls === 1 ? "" : "s"}`]);
        }
        if (action === "remove" && before) setNotice(`${before.name} removed; ${before.day_name} is left empty for this week.`);
      } catch (err) {
        setFailure({ message: err instanceof Error ? err.message : String(err), status: (err as { status?: number }).status });
      } finally {
        setSwapping(null);
        setPhase("idle");
      }
    },
    [plan, send],
  );

  const approve = useCallback(async () => {
    if (!plan) return;
    setPhase("acting");
    setFailure(null);
    setNotice(null);
    try {
      const r = await send(`/api/plans/${plan.id}/approve`, "POST");
      setPlan(r.plan);
      setNotice(`Week approved: ${r.plan.cards.length} activities stamped. After each one, rate pleasure (P) and mastery (M) from 0 to 10.`);
    } catch (err) {
      setFailure({ message: err instanceof Error ? err.message : String(err), status: (err as { status?: number }).status });
    } finally {
      setPhase("idle");
    }
  }, [plan, send]);

  /** save pending ratings; returns the stored plan (or null on failure) */
  const saveRatings = useCallback(async (): Promise<PlanDoc | null> => {
    if (!plan) return null;
    const ratings = changedRatings(plan.cards, pending);
    if (ratings.length === 0) return plan;
    setPhase("acting");
    setFailure(null);
    try {
      const r = await send(`/api/plans/${plan.id}/ratings`, "POST", { ratings });
      setPlan(r.plan);
      setPending({});
      setNotice(`${ratingsSaved(r.plan)} activities rated.`);
      return r.plan;
    } catch (err) {
      setFailure({ message: err instanceof Error ? err.message : String(err), status: (err as { status?: number }).status });
      return null;
    } finally {
      setPhase("idle");
    }
  }, [plan, pending, send]);

  const replan = useCallback(async () => {
    const saved = await saveRatings();
    if (saved) await run(saved);
  }, [saveRatings, run]);

  const mode: "draft" | "rate" | "locked" | null = !plan ? null : plan.status === "draft" ? "draft" : plan.next_plan_id ? "locked" : "rate";
  const coverage = useMemo(() => (plan ? coverageRefusal(plan, c) : null), [plan, c]);
  const outage = useMemo(() => (plan ? outageState(plan) : null), [plan]);
  const threads = useMemo(() => (plan && prev ? emberThreads(plan.diff, prev.cards) : []), [plan, prev]);

  const days: DayView[] = useMemo(() => {
    const strikes = plan ? strikesByDay(plan) : null;
    const reviews = plan ? reviewsByDay(plan) : null;
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
        review: reviews?.[day] ?? [],
        pending: !plan && phase === "streaming",
        recheck: phase === "toggling" && !!card && card.rung !== "home",
        fresh,
        gate:
          card && mode
            ? {
                mode,
                busy: swapping === card.id,
                disabled: phase !== "idle",
                approved: card.clinician_action === "approved",
                onAction: (a: CardAction) => void act(card.id, a),
                rating: pending[card.id] ?? { pleasure: card.pleasure, mastery: card.mastery },
                onRate: (r: PendingRating) => setPending((p) => ({ ...p, [card.id]: r })),
              }
            : null,
        ember: card ? (threads.find((t) => t.to_id === card.qloo_entity_id) ?? null) : null,
      };
    });
  }, [plan, streamed, phase, fresh, mode, swapping, pending, act, threads]);

  const traceLines = plan && live.length === 0 ? traceFromPlan(plan) : live;
  const stats = {
    qlooCalls: plan ? plan.qloo_calls : qloo,
    llm: plan ? (plan.llm_model ? `${plan.llm_provider}:${plan.llm_model}` : "deterministic route") : null,
    seconds: plan ? plan.latency_ms / 1000 : null,
    secondsLabel: plan?.origin === "toggle" ? "last update" : plan?.origin === "replan" ? "re-plan time" : "plan time",
    planId: plan?.id ?? null,
  };

  return (
    <>
      <CaseStrip c={c} week={plan?.week ?? (prev ? prev.week + 1 : 1)} disabled={phase !== "idle" || !plan || plan.status !== "draft"} onToggle={toggle} stamp={plan?.approved_at ? stampLabel(plan.approved_at) : null} />
      {phase === "streaming" && (
        <p className={s.notice} role="status">
          {prev
            ? `Re-planning week ${prev.week + 1} live from the ratings: rated ≥7 become Qloo signals, rated ≤3 are excluded, the same verifier strikes what fails.`
            : "Planning live: the agent routes each slot, Qloo returns candidates, the verifier strikes what fails."}
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
      {outage && phase === "idle" && (
        <div className={s.outageBox} role="alert" data-testid="outage-banner">
          <p>
            <strong>Qloo unavailable.</strong> {outage.slots} slot{outage.slots === 1 ? " was" : "s were"} left empty because Qloo did not answer. Nothing on this
            sheet was suggested by the model on its own: a slot is filled only by a Qloo entity that passed the verifier.
          </p>
          {outage.injected && (
            <p className={s.reason}>
              Labelled demo: this run was started from /judge with an unreachable Qloo host on purpose, so no request reached Qloo. It is excluded from the receipts.
            </p>
          )}
        </div>
      )}
      {coverage && phase === "idle" && (
        <div className={s.coverageBox} role="note" data-testid="coverage-refusal">
          <p>
            <strong>Coverage refusal.</strong> {coverage.headline} The empty slots stay empty rather than hold an unverified suggestion.
          </p>
          <ul>
            {coverage.slots.map((x) => (
              <li key={x.day} className={s.reason}>
                {x.line}
              </li>
            ))}
          </ul>
          {coverage.widen && plan?.status === "draft" ? (
            <p>
              <button type="button" className={`${s.btn} ${s.btnQuiet}`} disabled={phase !== "idle"} onClick={() => void toggle({ max_meters: coverage.widen! })} data-testid="widen-radius">
                Widen to {distanceLabel(coverage.widen).slice(1)} with clinician consent
              </button>{" "}
              <span className={s.reason}>re-checks the week and retries only the empty outings, live</span>
            </p>
          ) : (
            <p className={s.reason}>{coverage.widen ? "The week is approved; widen the radius on a new draft." : "Already at the widest radius: this area is outside what Qloo can verify for these constraints."}</p>
          )}
        </div>
      )}
      <div className={s.grid}>
        <EmberThreads threads={threads}>
          {prev && plan?.diff && <ReplanStrip prev={prev} threads={threads} />}
          <WeekLedger days={days} />
          {prev && plan?.diff && <ReplanSummary prev={prev} diff={plan.diff} threads={threads} />}
        </EmberThreads>
        <AgentTrace lines={traceLines} stats={stats} live={phase === "streaming"} />
      </div>
      <GateBar plan={plan} mode={mode} busy={phase !== "idle"} rated={plan ? ratedCount(plan.cards, pending) : 0} dirty={plan ? changedRatings(plan.cards, pending).length : 0} onApprove={approve} onSave={() => void saveRatings()} onReplan={() => void replan()} />
      <div className={s.bar}>
        <span>{mode === "draft" || !mode ? "Draft week for clinician review." : "Approved by the clinician."} Fictional case: never enter a real patient&apos;s name.</span>
        {plan && (
          <span className={s.reason}>
            plan {plan.id.slice(0, 8)} · {plan.origin === "toggle" ? "constraint change" : plan.origin === "replan" ? `re-planned from week ${plan.week - 1}` : "agent run"} · {new Date(plan.created_at).toUTCString().slice(5, 22)} UTC
          </span>
        )}
      </div>
    </>
  );
}

const ratingsSaved = (p: PlanDoc) => p.cards.filter((c) => c.pleasure !== null).length;

/** Approve bar (ui.md 4) on a draft; ratings + re-plan (ui.md 5) on an approved week; a link once re-planned. */
function GateBar(o: { plan: PlanDoc | null; mode: "draft" | "rate" | "locked" | null; busy: boolean; rated: number; dirty: number; onApprove: () => void; onSave: () => void; onReplan: () => void }) {
  const { plan, mode } = o;
  if (!plan || !mode) return null;
  if (mode === "draft") {
    const n = plan.cards.filter((c) => c.clinician_action === "approved").length;
    return (
      <div className={s.gateBar} data-testid="gate-bar">
        <p>
          Nothing reaches the patient until you approve. Approve, swap or remove single cards, then approve the week: every card left on the sheet is stamped.
          <span className={s.reason}> {n} of {plan.cards.length} approved individually</span>
        </p>
        <button type="button" className={`${s.btn} ${s.btnStamp}`} disabled={o.busy || plan.cards.length === 0} onClick={o.onApprove} data-testid="approve-week">
          Approve week
        </button>
      </div>
    );
  }
  if (mode === "locked") {
    return (
      <div className={s.gateBar} data-testid="gate-bar">
        <p>This week was re-planned from its ratings; the ratings are locked.</p>
        <div className={s.gateBtns}>
          <Link className={`${s.btn} ${s.btnQuiet}`} href={`/plans/${plan.id}/print`} data-testid="print-link">
            Patient sheet
          </Link>
          <Link className={`${s.btn} ${s.btnQuiet}`} href={`/plans/${plan.next_plan_id}`} data-testid="next-week">
            Week {plan.week + 1} →
          </Link>
        </div>
      </div>
    );
  }
  const ready = o.rated >= MIN_RATED;
  return (
    <div className={s.gateBar} data-testid="gate-bar">
      <p>
        Rate each activity after it happens: pleasure (P) and mastery (M), 0–10. Rated ≥7 becomes next week&apos;s signal; rated ≤3 is excluded.
        <span className={s.reason} data-testid="rated-count">
          {" "}
          {o.rated} rated · {ready ? "ready to re-plan" : `${MIN_RATED - o.rated} more to re-plan`}
        </span>
      </p>
      <div className={s.gateBtns}>
        <Link className={`${s.btn} ${s.btnQuiet}`} href={`/plans/${plan.id}/print`} data-testid="print-link">
          Patient sheet
        </Link>
        <button type="button" className={`${s.btn} ${s.btnQuiet}`} disabled={o.busy || o.dirty === 0} onClick={o.onSave} data-testid="save-ratings">
          Save ratings
        </button>
        <button type="button" className={s.btn} disabled={o.busy || !ready} onClick={o.onReplan} data-testid="replan" title={ready ? undefined : `Rate at least ${MIN_RATED} activities`}>
          Re-plan week {plan.week + 1}
        </button>
      </div>
    </div>
  );
}
