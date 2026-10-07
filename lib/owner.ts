/**
 * Case ownership without logins. Creating a case (intake, a seeded profile, or a copy) sets an httpOnly `rk_owner`
 * cookie holding a random token and stores only its SHA-256 on the case. Every write route (plan, constraint toggles,
 * card actions, approve, ratings, re-plan) needs that cookie; reads stay public, so a shared /plans/<id> link shows the
 * week read-only with a "Copy this case" action. Bench runs (bench token) are exempt: they never share a case.
 */
import { createHash, randomBytes } from "node:crypto";
import { classify, cookie, type HasHeaders } from "./ratelimit";
import { NotFound } from "./service";
import type { CaseDoc, Store } from "./store";

export const OWNER_COOKIE = "rk_owner";
const TOKEN_RE = /^[A-Za-z0-9_-]{32,64}$/;

export class Forbidden extends Error {
  constructor(m: string) {
    super(m);
    this.name = "Forbidden";
  }
}

export const ownerHash = (token: string) => createHash("sha256").update(token).digest("hex");

/** the visitor's owner token, if the cookie is present and well-formed */
export function ownerToken(req: HasHeaders): string | null {
  const t = cookie(req, OWNER_COOKIE);
  return t && TOKEN_RE.test(t) ? t : null;
}

/** For a new case: the visitor's existing token (one browser owns all its cases) or a new one with its Set-Cookie. */
export function ownerForNewCase(req: HasHeaders, secure = process.env.NODE_ENV === "production"): { owner_hash: string; setCookie: Record<string, string> } {
  const existing = ownerToken(req);
  const token = existing ?? randomBytes(24).toString("base64url");
  const setCookie: Record<string, string> = existing ? {} : { "set-cookie": `${OWNER_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 365}${secure ? "; Secure" : ""}` };
  return { owner_hash: ownerHash(token), setCookie };
}

/** Can this request change this case and its weeks? */
export function canWrite(req: HasHeaders, c: Pick<CaseDoc, "owner_hash">, env: Record<string, string | undefined> = process.env): boolean {
  if (classify(req, env) === "bench") return true;
  const t = ownerToken(req);
  return !!c.owner_hash && !!t && ownerHash(t) === c.owner_hash;
}

export function assertOwner(req: HasHeaders, c: Pick<CaseDoc, "owner_hash">, env: Record<string, string | undefined> = process.env): void {
  if (!canWrite(req, c, env)) throw new Forbidden("this case belongs to another visitor, so it is read-only here; use “Copy this case” to plan your own copy");
}

/** The week's case must belong to this visitor (checked before the rate limiter: a refusal never costs quota). */
export async function assertPlanOwner(req: HasHeaders, store: Store, planId: string): Promise<void> {
  const plan = await store.getPlan(planId);
  if (!plan) throw new NotFound(`plan ${planId} not found`);
  const c = await store.getCase(plan.case_id);
  if (!c) throw new NotFound(`case ${plan.case_id} not found`);
  assertOwner(req, c);
}

export async function assertCaseOwner(req: HasHeaders, store: Store, caseId: string): Promise<CaseDoc> {
  const c = await store.getCase(caseId);
  if (!c) throw new NotFound(`case ${caseId} not found`);
  assertOwner(req, c);
  return c;
}
