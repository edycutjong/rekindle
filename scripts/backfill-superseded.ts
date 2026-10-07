/**
 * One-off data fix: weeks replaced by a constraint toggle before `superseded_by` existed get it now, so they can no
 * longer be approved or printed. For each parent, the newest toggle child wins (a second tab could fork a week twice).
 * Dry run by default; `--write` applies. Needs BLOB_READ_WRITE_TOKEN.
 *
 *   tsx scripts/backfill-superseded.ts [--write]
 */
import { PlanDoc, storeFromEnv } from "../lib/store";

async function main() {
  const write = process.argv.includes("--write");
  const store = storeFromEnv();
  const ids = await store.listPlanIds(1000);
  const plans = (await Promise.all(ids.map((id) => store.getPlan(id).catch(() => null)))).filter((p): p is PlanDoc => !!p);
  const newestChild = new Map<string, PlanDoc>();
  for (const p of plans) {
    if (p.origin !== "toggle" || !p.parent_plan_id) continue;
    const cur = newestChild.get(p.parent_plan_id);
    if (!cur || p.created_at > cur.created_at) newestChild.set(p.parent_plan_id, p);
  }
  let n = 0;
  for (const [parentId, child] of newestChild) {
    const parent = plans.find((p) => p.id === parentId);
    if (!parent || parent.superseded_by) continue;
    n++;
    console.log(`${write ? "set" : "would set"} ${parentId}.superseded_by = ${child.id} (parent status ${parent.status})`);
    if (write) await store.putPlan(PlanDoc.parse({ ...parent, superseded_by: child.id }));
  }
  console.log(`${plans.length} plans read, ${n} ${write ? "updated" : "to update"}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
