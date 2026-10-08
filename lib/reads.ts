/**
 * Request-scoped document reads for server components. generateMetadata and the page used to read the same plan and
 * case twice per view, and on Vercel Hobby every Blob read is a billed simple op (a2a r02). React `cache()` dedupes per
 * request only; nothing is shared across requests or visitors.
 *
 * a2a r06 safe mode: a read says which of three things happened. `missing` (no such document, a malformed id, or a
 * stored document that no longer parses) renders the 404 page; `down` (the store refused: StoreUnavailable) renders
 * "unavailable right now", never "Not found".
 */
import { cache } from "react";
import { headers } from "next/headers";
import { storeFor } from "./scope";
import { StoreUnavailable } from "./store";

export type DocRead<T> = { doc: T } | { missing: true } | { down: true };

export async function readDoc<T>(f: () => Promise<T | null>): Promise<DocRead<T>> {
  try {
    const d = await f();
    return d ? { doc: d } : { missing: true };
  } catch (e) {
    return e instanceof StoreUnavailable ? { down: true } : { missing: true };
  }
}

export const readPlan = cache(async (id: string) => readDoc(async () => storeFor({ headers: await headers() }).getPlan(id)));
export const readCase = cache(async (id: string) => readDoc(async () => storeFor({ headers: await headers() }).getCase(id)));
