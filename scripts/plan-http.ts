/**
 * HTTP end-to-end against a running app — local `next start` or the live URL:
 *   POST /api/cases/seed/maya → POST /api/cases/:id/plan (reads the SSE stream) → GET /api/plans/:id (reload)
 * Prints the event timeline, the D3 gate (plan ≤ 30 s, LLM-routed, 0 cards without an entity_id) and the D4 gate
 * (the reloaded plan equals the streamed plan).
 *
 *   npx tsx scripts/plan-http.ts [--base http://localhost:3000] [--seed maya] [--out spike/plan-http.json]
 */
import { writeFileSync } from "node:fs";
import { parseSse } from "../lib/http";
import type { PlanDoc } from "../lib/store";

const arg = (k: string, d?: string) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const BASE = (arg("--base", "http://localhost:3000") as string).replace(/\/+$/, "");
const SEED = arg("--seed", "maya") as string;
const OUT = arg("--out");

async function main() {
  const t0 = Date.now();
  const sr = await fetch(`${BASE}/api/cases/seed/${SEED}`, { method: "POST" });
  if (sr.status !== 201) throw new Error(`seed → ${sr.status} ${await sr.text()}`);
  const { case: c } = await sr.json();
  console.log(`case ${c.id} (${c.label}, fictional seed) created in ${Date.now() - t0} ms`);

  const t1 = Date.now();
  const res = await fetch(`${BASE}/api/cases/${c.id}/plan`, { method: "POST" });
  if (!res.ok || !res.body) throw new Error(`plan → ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const frames: { event: string; data: unknown; ms: number }[] = [];
  let firstCardMs: number | null = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop() ?? "";
    for (const f of parseSse(parts.join("\n\n"))) {
      const ms = Date.now() - t1;
      frames.push({ ...f, ms });
      const d = f.data as Record<string, unknown>;
      if (f.event === "tool") {
        const card = d.card as { name: string } | null;
        if (card && firstCardMs === null) firstCardMs = ms;
        console.log(`  +${String(ms).padStart(5)} ms tool/${d.routedBy} ${d.tool} ${JSON.stringify(d.params)} → ${card ? card.name : `EMPTY: ${d.empty}`}`);
      } else if (f.event === "llm") console.log(`  +${String(ms).padStart(5)} ms llm ${d.provider}:${d.model} step ${d.step} (${d.ms} ms) → ${(d.toolCalls as string[]).join(", ")}`);
      else if (f.event === "llm_fallback" || f.event === "error" || f.event === "truth_boundary") console.log(`  +${String(ms).padStart(5)} ms ${f.event} ${JSON.stringify(d)}`);
    }
  }
  const last = frames.at(-1);
  if (!last || last.event !== "plan") throw new Error(`stream ended with ${last?.event}: ${JSON.stringify(last?.data)}`);
  const plan = (last.data as { plan: PlanDoc }).plan;
  const streamMs = last.ms;

  const t2 = Date.now();
  const gr = await fetch(`${BASE}/api/plans/${plan.id}?calls=1`);
  const { plan: reloaded, calls } = (await gr.json()) as { plan: PlanDoc; calls: unknown[] };
  const reloadMs = Date.now() - t2;
  const same = JSON.stringify(reloaded) === JSON.stringify(plan);

  for (const k of plan.cards) console.log(`  ${k.day_name.slice(0, 3)} ${String(k.hour).padStart(2, "0")}:00 ${k.rung.padEnd(6)} ${k.name}${k.distance_m !== undefined ? ` · ${k.distance_m} m · ${k.hours_text}` : ""} · ${k.routed_by} · "${k.coaching}" (${k.coaching_by})`);
  for (const e of plan.empty_slots) console.log(`  ${e.day_name.slice(0, 3)} EMPTY ${e.reason}`);
  const noId = plan.cards.filter((k) => !k.qloo_entity_id).length;
  const llmRouted = plan.cards.filter((k) => k.routed_by === "llm").length + plan.empty_slots.filter((e) => e.routed_by === "llm").length;
  console.log(`D3 GATE: plan streamed in ${streamMs} ms (≤ 30000: ${streamMs <= 30000}) · first card at ${firstCardMs} ms · routed by ${plan.llm_provider ?? "deterministic"}:${plan.llm_model ?? "-"} · LLM-routed slots ${llmRouted}/7 · cards ${plan.cards.length}/7 · cards without an entity_id: ${noId} · truth-boundary drops ${plan.dropped.length}`);
  console.log(`D4 GATE: reload GET /api/plans/${plan.id} in ${reloadMs} ms → identical to the streamed plan: ${same} · stored Qloo calls ${calls.length} (plan says ${plan.qloo_calls})`);
  if (OUT) writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), base: BASE, fictional: true, streamMs, firstCardMs, reloadMs, identicalOnReload: same, plan, events: frames.map((f) => ({ event: f.event, ms: f.ms })) }, null, 2) + "\n");
  if (!same || noId > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
