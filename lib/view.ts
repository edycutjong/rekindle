/**
 * Pure view helpers for the week ledger (specs/ui.md). Every string a card shows is derived here from the stored plan
 * (Qloo data + verifier results), so the UI never states a fact the plan does not carry. Unit-tested in tests/view.test.ts.
 */
import type { CardDoc, CaseDoc, PlanDoc, RefusalDoc } from "./store";
import { DAYS, type DayName } from "./verify";

export const DAY_SHORT: Record<DayName, string> = { monday: "Mon", tuesday: "Tue", wednesday: "Wed", thursday: "Thu", friday: "Fri", saturday: "Sat", sunday: "Sun" };

export const fmtHour = (h: number) => `${String(h).padStart(2, "0")}:00`;

export const priceLabel = (n: number) => `≤${"$".repeat(Math.max(1, Math.min(4, n)))}`;

export function distanceLabel(m: number): string {
  return m >= 1000 ? `≤${(m / 1000).toFixed(m % 1000 === 0 ? 0 : 1)} km` : `≤${m} m`;
}

export const ENTITY_TYPE: Record<string, string> = {
  "urn:entity:artist": "artist",
  "urn:entity:podcast": "podcast",
  "urn:entity:book": "book",
  "urn:entity:tv_show": "TV show",
  "urn:entity:movie": "film",
  "urn:entity:place": "place",
};
export const typeLabel = (t: string | undefined) => (t ? (ENTITY_TYPE[t] ?? t.replace(/^urn:(entity|tag):/, "").replace(/_/g, " ")) : "tag");

/** "home · 10 min · 19:00", "solo · 15:00", "social · 14:00" */
export function rungLabel(c: Pick<CardDoc, "rung" | "hour">): string {
  return c.rung === "home" ? `home · 10 min · ${fmtHour(c.hour)}` : `${c.rung} · ${fmtHour(c.hour)}`;
}

/** Why line: the per-love explainability split (never the bare affinity), highest first, at most three loves. */
export function whyParts(explain: CardDoc["explain_json"]): { name: string; weight: string }[] {
  return [...explain]
    .filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((e) => ({ name: e.name || e.entity_id, weight: e.score.toFixed(2) }));
}

const check = (c: CardDoc, rule: string) => c.checks.find((x) => x.rule === rule);

/** Hours check for an outing: `1161 m · Thu 12:00–18:00 · slot 15:00 ✓` (+ the re-slot, when there was one). */
export function hoursCheck(c: CardDoc): { distance: string | null; hours: string | null; slot: string; ok: boolean; moved: string | null } | null {
  if (c.rung === "home") return null;
  const open = check(c, "R-OPEN");
  return {
    distance: c.distance_m !== undefined ? `${c.distance_m} m` : null,
    hours: c.hours_text ?? null,
    slot: `slot ${fmtHour(c.hour)}`,
    ok: open?.verdict === "PASS",
    moved: c.moved_from !== undefined && c.moved_from !== c.hour ? `moved from ${fmtHour(c.moved_from)} (closed then)` : null,
  };
}

/** The rules a placed outing passed, short and in data face: R-OPEN ✓ R-NEAR ✓ … (title carries the detail). */
export function passedChecks(c: CardDoc): { rule: string; detail: string }[] {
  if (c.rung === "home") return c.checks.filter((x) => x.rule === "R-ID" && x.verdict === "PASS").map((x) => ({ rule: x.rule, detail: "a Qloo entity returned in this run" }));
  return c.checks.filter((x) => x.verdict === "PASS").map((x) => ({ rule: x.rule, detail: x.detail }));
}

/** One line per refused candidate, deduplicated per day (the social fallback ladder can see a venue twice). */
export interface Strike {
  key: string;
  name: string;
  rule: string;
  detail: string;
  verdict: RefusalDoc["verdict"];
  hour: number;
  movedTo: number | null;
  byToggle: boolean;
}

export function strikesByDay(plan: Pick<PlanDoc, "refusals" | "cards">): Record<DayName, Strike[]> {
  const out = Object.fromEntries(DAYS.map((d) => [d, [] as Strike[]])) as Record<DayName, Strike[]>;
  const seen = new Set<string>();
  // refusals struck by a constraint toggle first: they are the ones that just changed on the sheet
  const ordered = [...plan.refusals].sort((a, b) => Number(!!b.struck_by_toggle) - Number(!!a.struck_by_toggle));
  for (const r of ordered) {
    const key = `${r.day_name}|${r.qloo_entity_id}|${r.rule}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out[r.day_name].push({ key, name: r.name, rule: r.rule, detail: r.detail, verdict: r.verdict, hour: r.hour, movedTo: r.moved_to ?? null, byToggle: !!r.struck_by_toggle });
  }
  return out;
}

/** Long rule details (R-ALC can list a dozen tags) are cut to the first two items; the full text goes in a title. */
export function shortDetail(detail: string, max = 2): string {
  const items = detail.split(", ");
  if (items.length <= max) return detail;
  return `${items.slice(0, max).join(", ")} +${items.length - max} more`;
}

/** The reason line under a strike, e.g. `R-ALC · cocktail_bar · struck when a constraint changed`. */
export function strikeReason(s: Strike): string {
  const parts = [s.rule, shortDetail(s.detail)];
  if (s.movedTo !== null) parts.push(`→ moved to ${fmtHour(s.movedTo)}`);
  if (s.byToggle) parts.push("struck when a constraint changed");
  return parts.join(" · ");
}

export interface Loved {
  kind: string;
  name: string;
}
export const lovedTokens = (c: Pick<CaseDoc, "loves">): Loved[] => c.loves.map((l) => ({ kind: l.qloo_kind === "tag" ? "tag" : typeLabel(l.entity_type), name: l.name || l.text }));

/** Trace lines rebuilt from a stored plan (reload): one per routed slot + refusals by rule. */
export function traceFromPlan(plan: PlanDoc): string[] {
  const lines: string[] = [];
  if (plan.origin === "toggle" && plan.toggle) {
    lines.push(`constraint change ${Object.entries(plan.toggle.changed).map(([k, v]) => `${k}=${v}`).join(", ")} → struck ${plan.toggle.struck} · refilled ${plan.toggle.refilled} · ${(plan.toggle.ms / 1000).toFixed(1)} s`);
  }
  const strikes = strikesByDay(plan);
  const slots = [...plan.cards.map((c) => ({ day: c.day_name, card: c as CardDoc | null, empty: null as string | null })), ...plan.empty_slots.map((e) => ({ day: e.day_name, card: null, empty: e.reason }))].sort((a, b) => DAYS.indexOf(a.day) - DAYS.indexOf(b.day));
  for (const s of slots) {
    const tool = s.card?.tool ?? "slot";
    const params = s.card ? Object.entries(s.card.tool_params).map(([k, v]) => `${k}=${String(v)}`).join(" ") : "";
    const byRule = countBy(strikes[s.day].map((x) => x.rule));
    const refused = Object.keys(byRule).length ? ` · refused ${Object.entries(byRule).map(([r, n]) => `${r} ${n}`).join(", ")}` : "";
    const route = s.card ? ` (${s.card.routed_by})` : "";
    lines.push(`${tool} ${params}${route} → ${s.card ? s.card.name : `empty: ${s.empty}`}${refused}`.replace(/\s+/g, " "));
  }
  return lines;
}

export function countBy(xs: string[]): Record<string, number> {
  const o: Record<string, number> = {};
  for (const x of xs) o[x] = (o[x] ?? 0) + 1;
  return o;
}

/** Live trace line for one SSE event (null = not shown as its own line). */
export function traceLine(e: { type: string } & Record<string, unknown>): string | null {
  switch (e.type) {
    case "start":
      return `start week ${e.week} · ${(e.slots as unknown[]).length} slots · LLM ${(e.llm as string[]).join(" → ") || "none (deterministic)"}`;
    case "llm":
      return `${e.provider}:${e.model} step ${e.step} · ${(e.toolCalls as string[]).length} tool call${(e.toolCalls as string[]).length === 1 ? "" : "s"} · ${e.ms} ms`;
    case "llm_fallback":
      return `LLM fallback ${e.from} → ${e.to ?? "deterministic route"}`;
    case "tool": {
      const p = Object.entries((e.params as Record<string, unknown>) ?? {}).map(([k, v]) => `${k}=${String(v)}`).join(" ");
      const rf = Object.entries((e.refusals as Record<string, number>) ?? {}).map(([r, n]) => `${r} ${n}`).join(", ");
      const card = e.card as { name: string } | null;
      return `${e.tool} ${p} → ${e.returned} returned${rf ? ` · refused ${rf}` : ""}${e.review ? ` · review ${e.review}` : ""} → ${card ? `${card.name} ✓` : `empty: ${e.empty ?? "no verified candidate"}`}`.replace(/\s+/g, " ");
    }
    case "tool_rejected":
      return `rejected ${e.tool} ${e.day}: ${e.reason}`;
    case "truth_boundary":
      return `truth boundary dropped ${(e.dropped as unknown[]).length} line(s)`;
    default:
      return null;
  }
}

export const CONSTRAINT_FLAGS = [
  { key: "in_recovery", label: "In recovery" },
  { key: "need_quiet", label: "Quiet" },
  { key: "need_wheelchair", label: "Wheelchair entrance" },
] as const;

export const DISTANCE_OPTIONS = [800, 1500, 3000, 5000] as const;
export const PRICE_OPTIONS = [1, 2, 3, 4] as const;
