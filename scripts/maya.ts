/**
 * Maya end-to-end (build-plan D2), live against Qloo. Fictional case; every card comes from this run.
 *
 *   1. resolve Maya's loves (/search pinned by type, /v2/tags for "ramen")
 *   2. week 1 with "in recovery" OFF
 *   3. clinician toggles "in recovery" ON → struck cards + refill with the 14-tag exclusion + screen
 *   4. seed ratings (top at-home 7, top outing 8, lowest outing 2) → week 2 re-plan → diff
 *
 *   QLOO_API_KEY=… npx tsx scripts/maya.ts [--out spike/maya-e2e.json]
 *   … npx tsx scripts/maya.ts --agent [--out spike/maya-agent.json]   (D3: weeks 1 and 2 routed by the LLM agent loop)
 */
import { writeFileSync } from "node:fs";
import { qlooFromEnv, type QlooCallLog, type QlooClient } from "../lib/qloo";
import { applyConstraints, EMPTY_HISTORY, planWeek, type CaseRow, type Love, type WeekPlan } from "../lib/plan";
import { diffWeeks, historyFromRatings, seedRatings } from "../lib/replan";
import { cardsWithoutEntity, runAgent, type AgentEvent, type AgentPlan } from "../lib/agent";
import { llmChainFromEnv } from "../lib/llm";

const OUT = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : undefined;
const AGENT = process.argv.includes("--agent");
const calls: QlooCallLog[] = [];
const qloo = qlooFromEnv((l) => calls.push(l));
const agentPlans: AgentPlan[] = [];
const events: AgentEvent[] = [];

function trace(e: AgentEvent) {
  events.push(e);
  if (e.type === "llm") console.log(`  [llm] ${e.provider}:${e.model} step ${e.step} ${e.ms} ms → ${e.toolCalls.join(", ") || "(text)"} (${e.finishReason})`);
  else if (e.type === "tool") console.log(`  [tool/${e.routedBy}] ${e.tool} ${JSON.stringify(e.params)} ${e.ms} ms · ${e.returned} returned · ${e.card ? e.card.name : `EMPTY: ${e.empty}`} · refusals ${JSON.stringify(e.refusals)}`);
  else if (e.type === "llm_fallback") console.log(`  [llm_fallback] ${e.from} → ${e.to ?? "deterministic"}: ${e.error}`);
  else if (e.type === "tool_rejected") console.log(`  [tool_rejected] ${e.tool} ${e.day}: ${e.reason}`);
  else if (e.type === "truth_boundary") for (const d of e.dropped) console.log(`  [truth_boundary] dropped ${d.rule} ${d.entity_id}: ${d.detail}`);
}

/** Week planner: deterministic (D2) or the LLM agent loop (D3, --agent). */
async function plan(c: CaseRow, week: number, history = EMPTY_HISTORY): Promise<WeekPlan> {
  if (!AGENT) return planWeek(qloo, c, week, history);
  const llms = llmChainFromEnv();
  if (!llms.length) throw new Error("--agent needs QWEN_API_KEY or GROQ_API_KEY");
  const p = await runAgent({ qloo, case: c, week, history, llms, onEvent: trace });
  agentPlans.push(p);
  console.log(`  agent: routed by ${p.llm ? `${p.llm.provider}:${p.llm.model}` : "deterministic fallback"} · ${p.llmSteps} LLM steps, ${p.llmMs} ms · slots routed by LLM ${p.slots.filter((s) => s.routedBy === "llm").length}/7 · coaching by LLM ${p.slots.filter((s) => s.coachingBy === "llm").length} · dropped ${p.dropped.length} · total ${p.latencyMs} ms`);
  for (const s of p.slots) if (s.card) console.log(`    coaching ${s.slot.day}: "${s.coaching}" (${s.coachingBy})`);
  return p;
}

async function resolveEntity(q: QlooClient, text: string, type: string): Promise<Love> {
  const r = await q.search(text, { types: [type], take: 3 });
  const hit = r.results[0];
  if (!hit) throw new Error(`"${text}" did not resolve in Qloo (${type})`);
  return { text, qlooId: hit.entity_id, kind: "entity", entityType: type, name: hit.name };
}
async function resolveTag(q: QlooClient, text: string): Promise<Love> {
  const r = await q.tags(text, { take: 20 });
  const tags = r.results.tags.map((t) => t.id ?? "");
  // place-genre tags drive place ranking (P14); prefer them over dish / menu tags
  const pick = tags.find((t) => t.startsWith("urn:tag:genre:place:restaurant:")) ?? tags.find((t) => t.includes(":place")) ?? tags[0];
  if (!pick) throw new Error(`"${text}" did not resolve to a Qloo tag`);
  return { text, qlooId: pick, kind: "tag", name: text };
}

const fmtH = (h: number) => `${String(h).padStart(2, "0")}:00`;
const DAY = (d: string) => d.slice(0, 3).replace(/^./, (x) => x.toUpperCase());

function printWeek(title: string, w: WeekPlan) {
  console.log(`\n### ${title}`);
  for (const s of w.slots) {
    const c = s.card;
    if (!c) {
      console.log(`- ${DAY(s.slot.day)} ${fmtH(s.slot.hour)} ${s.slot.rung.padEnd(6)} — EMPTY: ${s.empty}`);
      continue;
    }
    const why = c.why.map((x) => `${x.name} ${x.score.toFixed(2)}`).join(" · ");
    const place = c.rung === "home" ? c.entityType.replace("urn:entity:", "") : `${c.distance_m} m · ${c.hoursText} · slot ${fmtH(c.hour)}${c.movedFrom !== undefined ? ` (moved from ${fmtH(c.movedFrom)})` : ""}`;
    console.log(`- ${DAY(s.slot.day)} ${fmtH(c.hour)} ${c.rung.padEnd(6)} ${c.name} — ${place} — aff ${c.affinity.toFixed(3)} — because ${why}${c.geohash ? ` — cell ${c.geohash}` : ""}`);
  }
  const byRule = w.refusals.reduce<Record<string, number>>((a, r) => ((a[r.rule] = (a[r.rule] ?? 0) + 1), a), {});
  console.log(`  refusals by rule: ${JSON.stringify(byRule)} · REVIEW held: ${w.review.map((r) => r.name).join(", ") || "none"}`);
}

async function main() {
  const t0 = Date.now();
  const loves = [await resolveEntity(qloo, "Phoebe Bridgers", "urn:entity:artist"), await resolveEntity(qloo, "Fleabag", "urn:entity:tv_show"), await resolveTag(qloo, "ramen")];
  console.log(`Maya (fictional) — run ${new Date().toISOString()}`);
  console.log(`loves: ${loves.map((l) => `${l.text} → ${l.qlooId}`).join(" | ")}`);

  const maya: CaseRow = { label: "Maya", lon: -73.9571, lat: 40.7081, energy: 1, priceMax: 2, maxMeters: 1500, inRecovery: false, needQuiet: false, needWheelchair: false, loves };

  const t1 = Date.now();
  const w1 = await plan(maya, 1);
  const w1ms = Date.now() - t1;
  printWeek(`Week 1 — in recovery OFF (${w1ms} ms)`, w1);

  const t2 = Date.now();
  const mayaRec = { ...maya, inRecovery: true };
  const w1r = await applyConstraints(qloo, w1, mayaRec);
  const togglems = Date.now() - t2;
  console.log(`\n### Toggle "in recovery" ON (${togglems} ms): ${w1r.struck.length} struck, ${w1r.refilled} slots refilled`);
  for (const s of w1r.struck) console.log(`  STRUCK ${s.name} — ${s.rule} ${s.detail}`);
  const refillRefusals = w1r.refusals.filter((r) => !w1.refusals.includes(r) && !r.struckByToggle);
  for (const r of refillRefusals.filter((x) => x.rule === "R-ALC")) console.log(`  refill screen: ${r.name} — ${r.rule} ${r.verdict} ${r.detail}`);
  printWeek("Week 1 — after the toggle (what the clinician approves)", w1r);

  const ratings = seedRatings(w1r);
  if (!ratings) throw new Error("week 1 has < 2 verified outings; the seed rating rule does not apply");
  const cards = w1r.slots.flatMap((s) => (s.card ? [s.card] : []));
  const nameOf = (id: string) => cards.find((c) => c.entity_id === id)?.name;
  console.log(`\n### Seed ratings: ${ratings.map((r) => `${nameOf(r.entity_id)} P${r.pleasure}/M${r.mastery}`).join(" · ")}`);
  const h2 = historyFromRatings(EMPTY_HISTORY, cards, ratings);
  console.log(`  week-2 signals +entities: ${h2.rekindled.map((r) => r.name).join(", ")} · +tags: ${h2.signalTags.join(", ") || "none"} · exclude entities: ${h2.lowRated.map(nameOf).join(", ")} · exclude tags: ${h2.excludeTags.join(", ") || "none"}`);

  const t3 = Date.now();
  const w2 = await plan(mayaRec, 2, h2);
  const w2ms = Date.now() - t3;
  printWeek(`Week 2 — re-planned from ratings (${w2ms} ms)`, w2);
  const diff = diffWeeks(w1r, w2, h2);
  console.log(`\n### Diff: kept ${diff.kept.length}, added ${diff.added.length}, removed ${diff.removed.length}`);
  for (const r of diff.removed) console.log(`  leaving out: ${r.name} (${r.reason})`);
  for (const e of diff.ember) console.log(`  ember: ${e.from} → ${e.to} (${DAY(e.day)}) ${e.score.toFixed(2)}`);
  const lowLeak = w2.slots.filter((s) => s.card && h2.lowRated.includes(s.card.entity_id)).length;
  const verified = (w: WeekPlan) => w.slots.filter((s) => s.card?.verdict === "PASS").length;
  console.log(`\nverified cards: week 1 ${verified(w1r)}/7, week 2 ${verified(w2)}/7 · ≤3-rated entity in week 2: ${lowLeak} · ember threads: ${diff.ember.length}`);
  console.log(`Qloo calls: ${calls.length} (non-200: ${calls.filter((c) => c.status !== 200).length}) · total ${Date.now() - t0} ms`);
  if (AGENT) {
    const noId = agentPlans.reduce((a, p) => a + cardsWithoutEntity(p), 0);
    const llmRouted = agentPlans.map((p) => p.slots.filter((s) => s.routedBy === "llm").length);
    console.log(`AGENT GATE: week 1 plan ${agentPlans[0].latencyMs} ms (≤ 30000: ${agentPlans[0].latencyMs <= 30000}) · week 2 plan ${agentPlans[1].latencyMs} ms · LLM-routed slots ${llmRouted.join(" / ")} of 7 · cards without an entity_id: ${noId}`);
  }

  if (OUT) writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), fictional: true, loves, timings_ms: { week1: w1ms, toggle: togglems, week2: w2ms }, week1: w1, toggle: { struck: w1r.struck, refilled: w1r.refilled }, week1AfterToggle: w1r, ratings, history: h2, week2: w2, diff, calls: calls.map((c) => ({ path: c.path, params: c.params, status: c.status, ms: c.ms, n_results: c.n_results })), ...(AGENT ? { agent: agentPlans.map((p) => ({ llm: p.llm, llmSteps: p.llmSteps, llmMs: p.llmMs, llmErrors: p.llmErrors, dropped: p.dropped, latencyMs: p.latencyMs, routed: p.slots.map((s) => ({ day: s.slot.day, tool: s.tool, params: s.params, routedBy: s.routedBy, card: s.card?.name ?? null, coaching: s.coaching, coachingBy: s.coachingBy })) })), events } : {}) }, null, 2) + "\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
