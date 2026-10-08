/**
 * Request-scoped document reads for server components. generateMetadata and the page used to read the same plan and
 * case twice per view, and on Vercel Hobby every Blob read is a billed simple op (a2a r02). React `cache()` dedupes per
 * request only; nothing is shared across requests or visitors. Same `.catch(() => null)` semantics as the call sites.
 */
import { cache } from "react";
import { headers } from "next/headers";
import { storeFor } from "./scope";

export const readPlan = cache(async (id: string) => storeFor({ headers: await headers() }).getPlan(id).catch(() => null));
export const readCase = cache(async (id: string) => storeFor({ headers: await headers() }).getCase(id).catch(() => null));
