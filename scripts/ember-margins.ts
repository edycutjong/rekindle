/**
 * Live ember margins: for every product re-plan stored on this deployment (origin "replan", the newest version of each
 * week), the ember rule the UI applies (lib/replan.ts emberLead, T16): a new week-2 card gets a thread and "because of"
 * when its top RATED input leads its best ORIGINAL-LOVE input by EMBER_MIN_MARGIN; a smaller lead is a tie. The rule
 * before T16 (lead over the card's next input of any kind, explainMargin) is reported beside it on the same cards.
 * Also counts, from bench/replan.json (scripts/replan_check.py), the bench's new cards that clear the same margin —
 * the bench stores exactly this margin per card. Read-only. Writes bench/ember-live.json, which /judge shows.
 *
 *   tsx scripts/ember-margins.ts [--out bench/ember-live.json] [--bench bench/replan.json]
 * On Blob it refuses unless ALLOW_BLOB_SCRIPT=1 (a2a r06: listPlanIds is a list(), an advanced op; script-guards.ts).
 */
import { readFile, writeFile } from "node:fs/promises";
import { EMBER_MIN_MARGIN, emberLead, explainMargin } from "../lib/replan";
import { storeFromEnv, type PlanDoc } from "../lib/store";
import { assertListAllowed } from "./script-guards";

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const r4 = (n: number | null) => (n === null ? null : Math.round(n * 1e4) / 1e4);

async function main() {
  const outIdx = process.argv.indexOf("--out");
  const out = outIdx > 0 ? process.argv[outIdx + 1]! : "bench/ember-live.json";
  const store = storeFromEnv();
  assertListAllowed(store);
  const ids = await store.listPlanIds(1000);
  const plans = (await Promise.all(ids.map((id) => store.getPlan(id).catch(() => null)))).filter((p): p is PlanDoc => !!p);
  const weeks = plans.filter((p) => p.diff && !p.superseded_by && (p.origin === "replan" || p.parent_plan_id));
  /** current rule (T16): top rated weight - best original-love weight, on cards a rating leads (>= 0) */
  const overLoves: number[] = [];
  /** previous rule: the rekindled entity's lead over the card's next input of any kind, on cards it tops */
  const overNext: number[] = [];
  let cards = 0;
  let withCo = 0;
  /** Qloo returns the same week for the same signals, so repeated re-plans of one rating set repeat cards: count each
   *  (rated set, card entity) once as well */
  const distinct = new Map<string, { margin: number; next: number }>();
  for (const p of weeks) {
    const rek = new Set(p.history.rekindled.map((r) => r.entity_id));
    const added = new Set(p.diff!.added.map((a) => `${a.day}|${a.name}`));
    for (const c of p.cards) {
      if (!added.has(`${c.day_name}|${c.name}`)) continue;
      const lead = emberLead(c.explain_json, rek);
      if (!lead) continue;
      cards++;
      if (lead.margin >= 0) overLoves.push(lead.margin);
      if (lead.threads && lead.co.length) withCo++;
      const next = Math.max(...c.explain_json.filter((w) => rek.has(w.entity_id) && w.score > 0).map((w) => explainMargin(c.explain_json, w.entity_id)));
      if (next >= 0) overNext.push(next);
      distinct.set(`${[...rek].sort().join(",")}|${c.qloo_entity_id}`, { margin: lead.margin, next });
    }
  }
  const threaded = overLoves.filter((m) => m >= EMBER_MIN_MARGIN).length;
  const prevThreaded = overNext.filter((m) => m >= EMBER_MIN_MARGIN).length;
  const benchIdx = process.argv.indexOf("--bench");
  const benchPath = benchIdx > 0 ? process.argv[benchIdx + 1]! : "bench/replan.json";
  const benchDoc = JSON.parse(await readFile(benchPath, "utf8").catch(() => "null")) as { finished_at?: string; new_cards_total?: number; profiles?: { cards?: { margin: number | null }[] }[] } | null;
  const benchMargins = (benchDoc?.profiles ?? []).flatMap((r) => (r.cards ?? []).map((c) => c.margin)).filter((m): m is number => typeof m === "number");
  const benchThreaded = benchMargins.filter((m) => m >= EMBER_MIN_MARGIN).length;
  const doc = {
    generated_by: "scripts/ember-margins.ts",
    generated_at: new Date().toISOString(),
    definition: `Live product re-plans on this deployment (newest version of each week). For each new week-2 card whose explainability names a rated (>= 7) entity: margin = the top rated input's weight - the card's best original-love weight (lib/replan.ts emberLead, the bench's margin). A thread and "because of" need margin >= ${EMBER_MIN_MARGIN}; a smaller lead is a tie; a love that outweighs every rating gets no label. Qloo returns the same week for the same ratings, so \`distinct\` counts each (rated set, card) once. Qloo's attribution, not causation.`,
    threshold: EMBER_MIN_MARGIN,
    replans: weeks.length,
    new_cards_naming_a_rating: cards,
    rating_leads_loves: overLoves.length,
    threaded,
    tied: overLoves.length - threaded,
    threaded_with_co_inputs: withCo,
    margin_median: r4(median(overLoves)),
    margin_min: r4(overLoves.length ? Math.min(...overLoves) : null),
    margin_max: r4(overLoves.length ? Math.max(...overLoves) : null),
    /** the same counts with each (rated set, card entity) once */
    distinct: {
      cards: distinct.size,
      rating_sets: new Set([...distinct.keys()].map((k) => k.split("|")[0])).size,
      rating_leads_loves: [...distinct.values()].filter((d) => d.margin >= 0).length,
      threaded: [...distinct.values()].filter((d) => d.margin >= EMBER_MIN_MARGIN).length,
      previous_rule_threaded: [...distinct.values()].filter((d) => d.next >= EMBER_MIN_MARGIN).length,
    },
    /** the rule before T16, on the same cards, for a like-for-like comparison */
    previous_rule: {
      definition: "margin = the rekindled entity's weight - the card's strongest other input of any kind (another rating included)",
      rekindled_top: overNext.length,
      threaded: prevThreaded,
      margin_median: r4(median(overNext)),
    },
    /** bench/replan.json stores the same margin per new card (top rated - best original love) */
    bench: benchDoc
      ? { source: benchPath, finished_at: benchDoc.finished_at ?? null, new_cards: benchDoc.new_cards_total ?? null, cards_with_margin: benchMargins.length, threaded: benchThreaded, margin_median: r4(median(benchMargins)) }
      : null,
  };
  await writeFile(out, JSON.stringify(doc, null, 1) + "\n");
  console.log(JSON.stringify(doc, null, 1));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
