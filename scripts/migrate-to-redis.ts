/**
 * a2a r06: copy named weeks from the Blob store to Upstash Redis, with everything they link to — the case, the Qloo
 * call log, the week-1 and re-plan run markers, and the weeks linked by parent / next / superseded_by / diff.from.
 * Reads by path only (Blob simple ops, about 6 per week): it never calls list(), so it spends no advanced op.
 * At most 50 weeks per run. Writes go to the production keys (no `preview/` prefix) unless VERCEL_ENV says otherwise.
 *
 *   BLOB_READ_WRITE_TOKEN=… KV_REST_API_URL=… KV_REST_API_TOKEN=… tsx scripts/migrate-to-redis.ts <plan-id> [<plan-id> …]
 */
import { BlobStore, envKeyPrefix, redisFromEnv, RedisStore, type Store } from "../lib/store";

const MAX_WEEKS = 50;

/** reads by path from `from` (never listPlanIds) and writes each document to `to` */
export async function migrate(from: Pick<Store, "getPlan" | "getCase" | "getCalls" | "getRun" | "getReplanRun">, to: Pick<Store, "putCase" | "putPlan" | "putCalls" | "putRun">, ids: string[], log: (m: string) => void = console.log) {
  const queue = [...ids];
  const seen = new Set<string>();
  const out = { weeks: 0, cases: 0, calls: 0, runs: 0, missing: [] as string[] };
  while (queue.length && seen.size < MAX_WEEKS) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const plan = await from.getPlan(id);
    if (!plan) {
      out.missing.push(id);
      log(`missing ${id}`);
      continue;
    }
    const [c, calls, run, replanRun] = await Promise.all([from.getCase(plan.case_id), from.getCalls(id), from.getRun(plan.case_id), from.getReplanRun(id)]);
    if (c) {
      await to.putCase(c);
      out.cases++;
    }
    await to.putPlan(plan);
    out.weeks++;
    if (calls) {
      await to.putCalls(calls);
      out.calls++;
    }
    for (const r of [run, replanRun]) {
      if (!r) continue;
      await to.putRun(r);
      out.runs++;
    }
    log(`copied week ${plan.week} ${id} (case ${plan.case_id}${calls ? `, ${calls.calls.length} Qloo calls` : ""})`);
    for (const next of [plan.parent_plan_id, plan.next_plan_id, plan.superseded_by, plan.diff?.from_plan_id]) if (next && !seen.has(next)) queue.push(next);
  }
  if (queue.length) log(`stopped at ${MAX_WEEKS} weeks; ${queue.length} linked week(s) not copied`);
  return out;
}

async function main() {
  const ids = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  if (!ids.length) throw new Error("usage: tsx scripts/migrate-to-redis.ts <plan-id> [<plan-id> …]");
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) throw new Error("BLOB_READ_WRITE_TOKEN is not set (the source)");
  const redis = redisFromEnv();
  if (!redis) throw new Error("KV_REST_API_URL + KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_*) are not set (the target), or STORE_BACKEND=blob");
  const out = await migrate(new BlobStore(token), new RedisStore(redis, "", envKeyPrefix()), ids);
  console.log(JSON.stringify(out));
  if (out.missing.length) process.exitCode = 1;
}

if (process.argv[1]?.endsWith("migrate-to-redis.ts")) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
