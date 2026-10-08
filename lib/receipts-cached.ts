/**
 * a2a r06 (Vercel Hobby budget): /judge and /integrations/qloo are force-dynamic and crawlable, and the "latest plans"
 * view runs a store list() — on Blob an ADVANCED op, of 2,000 per rolling 30 days, with a 30-day lockout past it. The
 * per-instance 20 s Map in lib/receipts.ts bounds nothing when most views land on a cold instance, so this view is
 * computed at most once per RECEIPTS_TTL_S across instances (Next data cache), and RECEIPTS_PAUSED=1 skips it entirely.
 * One plan's receipts (`?plan=<id>`) stay live: two reads by path, no list(), and robots.txt disallows them.
 */
import { unstable_cache } from "next/cache";
import { latestReceipts, type Receipts } from "./receipts";
import { storeFromEnv, StoreUnavailable } from "./store";

export const RECEIPTS_TAG = "receipts";
export const receiptsPaused = (env: Record<string, string | undefined> = process.env) => env.RECEIPTS_PAUSED === "1";
export const RECEIPTS_PAUSED_NOTE =
  "Live receipts for the latest plans are paused to protect this deployment's storage budget. Each week's agent trace still lists its own Qloo calls, and one plan's receipts open from its link.";

/** a2a r06 safe mode: a store outage reads as such, not as a raw SDK message */
export const receiptsError = (e: unknown) =>
  e instanceof StoreUnavailable || (e instanceof Error && e.name === "StoreUnavailable")
    ? "storage is not answering right now, so the stored call logs cannot be read. The bench numbers on /judge come from committed files and are unaffected."
    : e instanceof Error
      ? e.message
      : String(e);

export const cachedLatestReceipts = (limit = 5): Promise<Receipts> =>
  unstable_cache(() => latestReceipts(storeFromEnv(), { limit }), ["receipts-latest", String(limit)], {
    revalidate: Number(process.env.RECEIPTS_TTL_S ?? 900),
    tags: [RECEIPTS_TAG],
  })();
