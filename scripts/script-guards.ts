/**
 * a2a r06 F5: a script that lists every plan must not do it on the Blob store by accident. On Vercel Hobby a Blob
 * list() is an advanced op (2,000 per rolling 30 days, then a 30-day lockout), and listPlanIds(1000) on Blob is one
 * list() plus one read per plan. On Redis it is one ZRANGE, so nothing changes there.
 */
import type { Store } from "../lib/store";

export function assertListAllowed(store: Pick<Store, "kind">, env: Record<string, string | undefined> = process.env): void {
  if (store.kind === "blob" && env.ALLOW_BLOB_SCRIPT !== "1")
    throw new Error("refusing to list() the Blob store (Hobby: 2,000 advanced ops per rolling 30 days, then a 30-day lockout); set ALLOW_BLOB_SCRIPT=1 to override");
}
