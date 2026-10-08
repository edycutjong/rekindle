/**
 * Live ember margins: for every product re-plan stored on this deployment (origin "replan", the newest version of each
 * week), the lead of the rekindled entity over each new card's strongest other explainability input — the same number
 * the UI uses to decide between "because of" (a thread) and "tied with" (lib/replan.ts EMBER_MIN_MARGIN). Read-only.
 * Writes bench/ember-live.json, which /judge shows beside the bench's median.
 *
 *   tsx scripts/ember-margins.ts [--out bench/ember-live.json]
 * On Blob it refuses unless ALLOW_BLOB_SCRIPT=1 (a2a r06: listPlanIds is a list(), an advanced op; script-guards.ts).
 */
import { writeFile } from "node:fs/promises";
import { EMBER_MIN_MARGIN, explainMargin } from "../lib/replan";
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
  const margins: number[] = [];
  /** the bench's definition (bench/replan.json): top rekindled weight - best non-rekindled (original love) weight */
  const overLoves: number[] = [];
  let cards = 0;
  for (const p of weeks) {
    const rek = new Set(p.history.rekindled.map((r) => r.entity_id));
    const added = new Set(p.diff!.added.map((a) => `${a.day}|${a.name}`));
    for (const c of p.cards) {
      if (!added.has(`${c.day_name}|${c.name}`)) continue;
      const leads = c.explain_json.filter((w) => rek.has(w.entity_id) && w.score > 0).map((w) => explainMargin(c.explain_json, w.entity_id));
      if (!leads.length) continue;
      cards++;
      const best = Math.max(...leads);
      if (best >= 0) margins.push(best);
      const topRek = Math.max(...c.explain_json.filter((w) => rek.has(w.entity_id)).map((w) => w.score));
      const topLove = Math.max(0, ...c.explain_json.filter((w) => !rek.has(w.entity_id)).map((w) => w.score));
      if (best >= 0) overLoves.push(topRek - topLove);
    }
  }
  const threaded = margins.filter((m) => m >= EMBER_MIN_MARGIN).length;
  const doc = {
    generated_by: "scripts/ember-margins.ts",
    generated_at: new Date().toISOString(),
    definition: `Live product re-plans on this deployment (newest version of each week). For each new week-2 card whose explainability names a rekindled (rated >= 7) entity: margin = that entity's weight - the card's strongest other input. A thread and "because of" need margin >= ${EMBER_MIN_MARGIN}; a smaller lead is shown as a tie.`,
    threshold: EMBER_MIN_MARGIN,
    replans: weeks.length,
    new_cards_naming_a_rating: cards,
    rekindled_top: margins.length,
    threaded,
    tied: margins.length - threaded,
    margin_median: r4(median(margins)),
    margin_min: r4(margins.length ? Math.min(...margins) : null),
    margin_max: r4(margins.length ? Math.max(...margins) : null),
    /** same cards, measured as the bench does (over the best original love only), for a like-for-like comparison */
    margin_over_original_loves_median: r4(median(overLoves)),
  };
  await writeFile(out, JSON.stringify(doc, null, 1) + "\n");
  console.log(JSON.stringify(doc, null, 1));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
