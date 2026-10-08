/**
 * Request-scoped document reads for server components. generateMetadata and the page used to read the same plan and
 * case twice per view, and on Vercel Hobby every Blob read is a billed simple op (a2a r02). React `cache()` dedupes per
 * request only; nothing is shared across requests or visitors.
 *
 * a2a r06 safe mode: a read says which of three things happened. `missing` (no such document, a malformed id, or a
 * stored document that no longer parses) renders the 404 page; `down` (the store refused: StoreUnavailable) renders
 * "unavailable right now", never "Not found".
 *
 * a2a r06 F4: page views are metered like the API GETs. One per-IP window hit per request (the `read` action, in
 * memory, zero store ops), checked before any store read; a refused view is `limited` and reads nothing.
 */
import { cache } from "react";
import { headers } from "next/headers";
import { limiterFromEnv, type Decision } from "./ratelimit";
import { storeFor } from "./scope";
import { StoreUnavailable } from "./store";

export type DocRead<T> = { doc: T } | { missing: true } | { down: true } | { limited: string };

/** the page-read guard, once per request (generateMetadata and the page share it) */
export const pageGate = cache(async (): Promise<Decision> => limiterFromEnv().check({ headers: await headers() }, "read"));

/** a refused view never touches the store */
export async function gatedRead<T>(gate: () => Promise<Decision>, f: () => Promise<T | null>): Promise<DocRead<T>> {
  const d = await gate();
  if (!d.ok) return { limited: d.message ?? "Too many requests from this address. Try again later." };
  return readDoc(f);
}

export async function readDoc<T>(f: () => Promise<T | null>): Promise<DocRead<T>> {
  try {
    const d = await f();
    return d ? { doc: d } : { missing: true };
  } catch (e) {
    return e instanceof StoreUnavailable ? { down: true } : { missing: true };
  }
}

export const readPlan = cache(async (id: string) => gatedRead(pageGate, async () => storeFor({ headers: await headers() }).getPlan(id)));
export const readCase = cache(async (id: string) => gatedRead(pageGate, async () => storeFor({ headers: await headers() }).getCase(id)));
