/**
 * Rate limiting. Protects the Qloo and LLM keys on a zero-login path without ever locking judges out.
 *
 * Three namespaces:
 *   public  everyone else: per-IP hourly limit + a global daily cap on plan runs
 *   judge   carries the judge token (cookie set by `/?judge=<token>`, or the `x-judge-token` header): its own daily
 *           ceiling, never counted against the public cap
 *   bench   carries the bench token (`x-bench-token`): exempt from the per-IP limit and from both other caps, with its
 *           own daily quota
 *
 * Backend. The per-IP window is in memory per serverless instance. The daily per-namespace counters follow the store
 * (lib/store.ts storeFromEnv): an atomic Redis INCR on `counters/<ns>/<yyyy-mm-dd>` (expires after 3 days) when
 * Upstash is configured; else the private Blob store (`counters/<ns>/<yyyy-mm-dd>.json`, read-modify-write, approximate
 * under concurrency, and each count spends a Blob advanced op: a2a r06); else in memory (local dev, tests).
 */
import { timingSafeEqual } from "node:crypto";
import { envKeyPrefix, redisFromEnv, type RedisLike } from "./store";

export type Namespace = "public" | "judge" | "bench";
/** what the request costs: `plan` runs the agent (Qloo + LLM); the others are cheap reads or single Qloo calls */
export type Action = "plan" | "toggle" | "resolve" | "write" | "health" | "read";

export const JUDGE_COOKIE = "rk_judge";

export interface Limits {
  /** requests per IP per hour, per action (Infinity = unlimited) */
  perIpPerHour: Record<Action, number>;
  /** plan runs per UTC day for the whole namespace */
  dailyPlans: number;
}

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) && n >= 0 ? n : d;
};

export function limitsFromEnv(env: Record<string, string | undefined> = process.env): Record<Namespace, Limits> {
  return {
    public: {
      perIpPerHour: { plan: num(env.RL_PUBLIC_PLANS_PER_IP_HOUR, 20), toggle: 40, resolve: 120, write: 40, health: 30, read: 120 },
      // 600/day ≈ 4× the expected judging-period traffic; re-size from the counter
      dailyPlans: num(env.RL_PUBLIC_DAILY_PLANS, 600),
    },
    judge: {
      perIpPerHour: { plan: num(env.RL_JUDGE_PLANS_PER_IP_HOUR, 60), toggle: 120, resolve: 240, write: 120, health: 60, read: 240 },
      dailyPlans: num(env.RL_JUDGE_DAILY_PLANS, 400),
    },
    bench: {
      perIpPerHour: { plan: Infinity, toggle: Infinity, resolve: Infinity, write: Infinity, health: Infinity, read: Infinity },
      dailyPlans: num(env.RL_BENCH_DAILY_PLANS, 400),
    },
  };
}

/** constant-time comparison; an unset expected token never matches */
export function tokenMatches(given: string | null | undefined, expected: string | undefined): boolean {
  if (!given || !expected || expected.length < 16) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** anything with request headers: a Request, or `{ headers: await headers() }` in a server component */
export type HasHeaders = { headers: Pick<Headers, "get"> };

export function cookie(req: HasHeaders, name: string): string | null {
  const raw = req.headers.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

/** Judge path is checked first after bench, so a judge is never counted against the public cap. */
export function classify(req: HasHeaders, env: Record<string, string | undefined> = process.env): Namespace {
  if (tokenMatches(req.headers.get("x-bench-token"), env.BENCH_TOKEN)) return "bench";
  if (tokenMatches(req.headers.get("x-judge-token"), env.JUDGE_TOKEN) || tokenMatches(cookie(req, JUDGE_COOKIE), env.JUDGE_TOKEN)) return "judge";
  return "public";
}

export function clientIp(req: HasHeaders): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}

/* ------------------------------------------------------------------ per-IP window (in memory) */

export class MemoryWindow {
  private readonly hits = new Map<string, { start: number; n: number }>();
  constructor(private readonly windowMs = 3_600_000) {}

  /** fixed window per key; returns whether this hit is allowed and when the window resets */
  hit(key: string, limit: number, now = Date.now()): { ok: boolean; remaining: number; resetMs: number } {
    if (limit === Infinity) return { ok: true, remaining: Infinity, resetMs: 0 };
    if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (now - v.start >= this.windowMs) this.hits.delete(k);
    let w = this.hits.get(key);
    if (!w || now - w.start >= this.windowMs) {
      w = { start: now, n: 0 };
      this.hits.set(key, w);
    }
    const resetMs = w.start + this.windowMs - now;
    if (w.n >= limit) return { ok: false, remaining: 0, resetMs };
    w.n++;
    return { ok: true, remaining: limit - w.n, resetMs };
  }
}

/* ------------------------------------------------------------------ daily counters */

export interface DailyCounter {
  readonly kind: "redis" | "blob" | "memory";
  get(ns: Namespace, day: string): Promise<number>;
  /** increments and returns the new value */
  incr(ns: Namespace, day: string): Promise<number>;
}

export class MemoryDailyCounter implements DailyCounter {
  readonly kind = "memory" as const;
  private readonly n = new Map<string, number>();
  async get(ns: Namespace, day: string) {
    return this.n.get(`${ns}/${day}`) ?? 0;
  }
  async incr(ns: Namespace, day: string) {
    const v = (await this.get(ns, day)) + 1;
    this.n.set(`${ns}/${day}`, v);
    return v;
  }
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Approximate daily counter on the private Blob store (non-atomic read-modify-write; see the header comment). */
export class BlobDailyCounter implements DailyCounter {
  readonly kind = "blob" as const;
  constructor(private readonly token: string) {}
  private path(ns: Namespace, day: string) {
    if (!DAY_RE.test(day)) throw new Error("invalid day");
    return `counters/${ns}/${day}.json`;
  }
  async get(ns: Namespace, day: string) {
    const { get } = await import("@vercel/blob");
    // @vercel/blob get(): null on 404, throws on every other failure; only "no counter yet" is 0 (a failed read used to
    // return 0 here, and incr() then wrote n = 1: one transient Blob error reset the day's cap)
    const r = await get(this.path(ns, day), { access: "private", token: this.token, useCache: false });
    if (!r || !r.stream) return 0;
    const v = JSON.parse(await new Response(r.stream).text()) as { n?: unknown };
    return typeof v.n === "number" ? v.n : 0;
  }
  async incr(ns: Namespace, day: string) {
    const { put } = await import("@vercel/blob");
    const n = (await this.get(ns, day)) + 1;
    await put(this.path(ns, day), JSON.stringify({ n, at: new Date().toISOString() }), { access: "private", token: this.token, contentType: "application/json", addRandomSuffix: false, allowOverwrite: true });
    return n;
  }
}

/** a2a r06: one atomic INCR per plan across every instance (the Blob counter read, then wrote, and spent an advanced op) */
export class RedisDailyCounter implements DailyCounter {
  readonly kind = "redis" as const;
  constructor(
    private readonly r: RedisLike,
    private readonly envPrefix = envKeyPrefix(),
  ) {}
  private key(ns: Namespace, day: string) {
    if (!DAY_RE.test(day)) throw new Error("invalid day");
    return `${this.envPrefix}counters/${ns}/${day}`;
  }
  async get(ns: Namespace, day: string) {
    const v = await this.r.get<string | number>(this.key(ns, day));
    const n = Number(v ?? 0);
    return Number.isFinite(n) ? n : 0;
  }
  async incr(ns: Namespace, day: string) {
    const k = this.key(ns, day);
    const [n] = await this.r.pipeline().incr(k).expire(k, 3 * 86_400).exec<[number, number]>();
    return Number(n);
  }
}

/* ------------------------------------------------------------------ limiter */

export interface Decision {
  ok: boolean;
  ns: Namespace;
  status: 200 | 429;
  reason?: "ip" | "daily";
  headers: Record<string, string>;
  message?: string;
}

export const utcDay = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

export class RateLimiter {
  readonly window = new MemoryWindow();
  /** a2a r06: when the shared counter cannot be read or written, the cap is counted here (per instance), never "unknown" */
  readonly fallback = new MemoryDailyCounter();
  constructor(
    readonly counter: DailyCounter,
    private readonly env: Record<string, string | undefined> = process.env,
  ) {}

  async check(req: Request, action: Action, now = Date.now()): Promise<Decision> {
    const ns = classify(req, this.env);
    const lim = limitsFromEnv(this.env)[ns];
    const perIp = lim.perIpPerHour[action];
    const w = this.window.hit(`${ns}:${action}:${clientIp(req)}`, perIp, now);
    const headers: Record<string, string> = { "x-ratelimit-namespace": ns };
    if (perIp !== Infinity) {
      headers["x-ratelimit-limit"] = String(perIp);
      headers["x-ratelimit-remaining"] = String(w.remaining);
    }
    if (!w.ok) {
      const retry = Math.ceil(w.resetMs / 1000);
      return { ok: false, ns, status: 429, reason: "ip", headers: { ...headers, "retry-after": String(retry) }, message: `Too many requests from this address — try again in ${Math.ceil(retry / 60)} min.` };
    }
    if (action !== "plan") return { ok: true, ns, status: 200, headers };
    const day = utcDay(now);
    let used: number;
    let counter: DailyCounter = this.counter;
    try {
      used = await this.counter.get(ns, day);
    } catch {
      // the shared counter is unreadable (store 5xx / 429 / quota / network): count on this instance instead, and
      // never overwrite the day's shared count from a failed read (a2a r06: never "unknown", the cap still holds)
      counter = this.fallback;
      used = await counter.get(ns, day);
      headers["x-ratelimit-counter"] = "instance";
    }
    headers["x-ratelimit-daily-limit"] = String(lim.dailyPlans);
    if (used >= lim.dailyPlans) {
      return {
        ok: false,
        ns,
        status: 429,
        reason: "daily",
        headers: { ...headers, "x-ratelimit-daily-remaining": "0" },
        message: ns === "public" ? "Daily public capacity reached. The receipts of the latest live runs are at /integrations/qloo." : `Daily ${ns} capacity reached.`,
      };
    }
    let n: number;
    try {
      n = await counter.incr(ns, day);
    } catch {
      // never below what the shared counter already said
      n = Math.max(used + 1, await this.fallback.incr(ns, day));
      headers["x-ratelimit-counter"] = "instance";
    }
    headers["x-ratelimit-daily-remaining"] = String(Math.max(0, lim.dailyPlans - n));
    return { ok: true, ns, status: 200, headers };
  }
}

let shared: RateLimiter | null = null;

/** The daily counter for this deployment: Redis, then Blob, then memory (the same precedence as the store). */
export function counterFromEnv(env: Record<string, string | undefined> = process.env): DailyCounter {
  const redis = redisFromEnv(env);
  if (redis) return new RedisDailyCounter(redis, envKeyPrefix(env));
  const token = env.BLOB_READ_WRITE_TOKEN;
  return token ? new BlobDailyCounter(token) : new MemoryDailyCounter();
}

/** One limiter per serverless instance. */
export function limiterFromEnv(env: Record<string, string | undefined> = process.env): RateLimiter {
  if (shared) return shared;
  shared = new RateLimiter(counterFromEnv(env), env);
  return shared;
}

/** 429 JSON response for a refused request (never a fake plan). */
export function refused(d: Decision): Response {
  return Response.json({ error: d.message ?? "rate limited", namespace: d.ns, reason: d.reason, receipts: "/integrations/qloo" }, { status: 429, headers: { ...d.headers, "cache-control": "no-store" } });
}

/** Guard for a route handler: returns a 429 response, or null and the headers to attach. */
export async function guard(req: Request, action: Action): Promise<{ deny: Response | null; headers: Record<string, string>; ns: Namespace }> {
  const d = await limiterFromEnv().check(req, action);
  return { deny: d.ok ? null : refused(d), headers: d.headers, ns: d.ns };
}
