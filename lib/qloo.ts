/**
 * Qloo client — typed GET wrapper for the hackathon API.
 *
 * - Base URL is pinned to https://hackathon.api.qloo.com (other hosts reject hackathon keys with 401).
 * - GET only (the hackathon guide documents /v2/insights as GET).
 * - One jittered retry on 5xx / network error / timeout; up to two on 429 (Retry-After honoured, capped at 3 s);
 *   8 s timeout per attempt.
 * - At most `maxConcurrent` requests in flight (default 3): the agent runs tools in parallel, and an unthrottled burst
 *   of 7+ calls drew a 429 in the first agent run (2026-10-07).
 * - Every request is reported to `onCall` (path, params, status, ms, result count). The key is never part of it.
 */

export const QLOO_HACKATHON_BASE = "https://hackathon.api.qloo.com";

export type ParamValue = string | number | boolean | readonly (string | number)[] | undefined | null;
export type QlooParams = Record<string, ParamValue>;

export interface QlooCallLog {
  path: string;
  params: Record<string, string>;
  status: number;
  ms: number;
  n_results: number;
  attempts: number;
  at: string;
  error?: string;
}

export class QlooError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly path: string,
  ) {
    super(message);
    this.name = "QlooError";
  }
}

export interface QlooClientOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  onCall?: (log: QlooCallLog) => void;
  /** injectable for tests */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** max requests in flight from this client (default 3) */
  maxConcurrent?: number;
  /** epoch ms: no attempt starts after it and an in-flight attempt is aborted at it (QLOO_RUN_BUDGET_MS) */
  deadline?: number;
  /** injectable clock (tests) */
  now?: () => number;
}

/**
 * Qloo time one plan / re-plan / toggle / swap may spend, so the week is stored before the route's maxDuration (60 s)
 * kills the function. Past it no attempt starts and an in-flight one is aborted; the slot says "Qloo unavailable".
 */
export const QLOO_RUN_BUDGET_MS = 40_000;
/** an attempt with less than this left before the deadline is not started */
const MIN_ATTEMPT_MS = 500;

/** Serialise params for a GET: arrays → comma-joined, booleans → "true"/"false", empty values dropped. */
export function encodeParams(params: QlooParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) {
      if (v.length === 0) continue;
      out[k] = v.join(",");
    } else {
      out[k] = String(v);
    }
  }
  return out;
}

/** Count results across the response shapes Qloo returns (entities, tags, heatmap, search). */
export function countResults(body: unknown): number {
  const b = body as { results?: unknown } | null;
  if (!b) return 0;
  const r = b.results;
  if (Array.isArray(r)) return r.length;
  if (r && typeof r === "object") {
    const o = r as Record<string, unknown>;
    for (const key of ["entities", "tags", "heatmap", "trends"]) {
      const v = o[key];
      if (Array.isArray(v)) return v.length;
    }
  }
  return 0;
}

const RETRYABLE = (status: number) => status === 429 || status >= 500;
const MAX_ATTEMPTS = 2;
const MAX_ATTEMPTS_429 = 3;

/** Retry-After (seconds or HTTP date) → ms, capped. */
export function retryAfterMs(h: string | null, cap = 3000): number | null {
  if (!h) return null;
  const n = Number(h);
  if (Number.isFinite(n)) return Math.min(cap, Math.max(0, n * 1000));
  const t = Date.parse(h);
  return Number.isFinite(t) ? Math.min(cap, Math.max(0, t - Date.now())) : null;
}

/** Minimal FIFO semaphore. */
class Gate {
  private active = 0;
  private readonly queue: (() => void)[] = [];
  constructor(private readonly max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

export class QlooClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly onCall?: (log: QlooCallLog) => void;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly gate: Gate;
  private readonly deadline?: number;
  private readonly now: () => number;

  constructor(opts: QlooClientOptions) {
    if (!opts.apiKey) throw new Error("QLOO_API_KEY is not set");
    const base = (opts.baseUrl ?? QLOO_HACKATHON_BASE).replace(/\/+$/, "");
    if (new URL(base).host !== new URL(QLOO_HACKATHON_BASE).host) {
      throw new Error(`Qloo base URL must be ${QLOO_HACKATHON_BASE} (got ${base})`);
    }
    this.apiKey = opts.apiKey;
    this.baseUrl = base;
    this.timeoutMs = opts.timeoutMs ?? 8000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.onCall = opts.onCall;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = opts.random ?? Math.random;
    this.gate = new Gate(Math.max(1, opts.maxConcurrent ?? 3));
    this.deadline = opts.deadline;
    this.now = opts.now ?? Date.now;
  }

  get<T = unknown>(path: string, params: QlooParams = {}): Promise<T> {
    return this.gate.run(() => this.getNow<T>(path, params));
  }

  private async getNow<T>(path: string, params: QlooParams): Promise<T> {
    const encoded = encodeParams(params);
    const url = `${this.baseUrl}${path}?${new URLSearchParams(encoded).toString()}`;
    const t0 = Date.now();
    let attempts = 0;
    let lastStatus = 0;
    let lastError = "";
    let wait: number | null = null;
    const maxAttempts = () => (lastStatus === 429 ? MAX_ATTEMPTS_429 : MAX_ATTEMPTS);
    const left = () => (this.deadline === undefined ? Infinity : this.deadline - this.now());
    while (attempts < maxAttempts()) {
      if (left() < MIN_ATTEMPT_MS) break;
      attempts++;
      wait = null;
      try {
        const res = await this.fetchImpl(url, {
          method: "GET",
          headers: { "X-Api-Key": this.apiKey, Accept: "application/json" },
          signal: AbortSignal.timeout(Math.min(this.timeoutMs, left())),
        });
        lastStatus = res.status;
        if (res.ok) {
          const body = (await res.json()) as T;
          this.log(path, encoded, res.status, t0, countResults(body), attempts);
          return body;
        }
        const text = await res.text().catch(() => "");
        lastError = text.slice(0, 300);
        if (!RETRYABLE(res.status)) break;
        if (res.status === 429) wait = retryAfterMs(res.headers.get("retry-after")) ?? 800 * attempts;
      } catch (e) {
        lastStatus = 0;
        lastError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      }
      if (attempts < maxAttempts()) {
        const pause = (wait ?? 250) + Math.floor(this.random() * 500);
        if (left() - pause < MIN_ATTEMPT_MS) break;
        await this.sleep(pause);
      }
    }
    if (left() < MIN_ATTEMPT_MS) lastError = lastError ? `run deadline reached (${lastError})` : "run deadline reached";
    // a request that never left the server is not a receipt
    if (attempts > 0) this.log(path, encoded, lastStatus, t0, 0, attempts, lastError);
    throw new QlooError(`Qloo ${path} failed (${lastStatus || "network"}): ${lastError}`, lastStatus, path);
  }

  private log(path: string, params: Record<string, string>, status: number, t0: number, n: number, attempts: number, error?: string) {
    this.onCall?.({ path, params, status, ms: Date.now() - t0, n_results: n, attempts, at: new Date().toISOString(), ...(error ? { error } : {}) });
  }

  /** GET /search — resolve free text to entities, pinned to types (P1). */
  search(query: string, opts: { types?: string[]; take?: number; extra?: QlooParams } = {}) {
    return this.get<SearchResponse>("/search", { query, types: opts.types, take: opts.take, ...(opts.extra ?? {}) });
  }

  /** GET /v2/tags — resolve food / activity loves to tag IDs (P3). */
  tags(query: string, opts: { take?: number; extra?: QlooParams } = {}) {
    return this.get<TagsResponse>("/v2/tags", { "filter.query": query, take: opts.take, ...(opts.extra ?? {}) });
  }

  /** GET /v2/insights */
  insights(params: QlooParams) {
    return this.get<InsightsResponse>("/v2/insights", params);
  }

  /** GET /entities?entity_ids= */
  entities(ids: string[]) {
    return this.get<SearchResponse>("/entities", { entity_ids: ids });
  }
}

/* ---------- response shapes (only the fields we read; captured 2026-10-07/08) ---------- */

export interface DayHours {
  opens: string | null; // "T08:00:00"
  closes: string | null; // "T18:00:00"
  closed?: boolean | null;
}
export type WeekHours = Partial<Record<"monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday", DayHours[] | DayHours>>;

/** /v2/insights tags carry `id`; /search hits carry `tag_id` (P23). */
export interface QlooTag {
  id?: string;
  tag_id?: string;
  name?: string;
  type?: string;
  value?: string;
}

export interface QlooEntity {
  entity_id: string;
  name: string;
  type?: string;
  subtype?: string;
  types?: string[];
  properties?: {
    hours?: WeekHours;
    address?: string;
    keywords?: { name: string; count?: number }[];
    price_level?: number;
    is_closed?: boolean | null;
    description?: string;
    [k: string]: unknown;
  };
  location?: { lat: number; lon: number; geohash?: string };
  tags?: QlooTag[];
  query?: {
    affinity?: number;
    distance?: number;
    explainability?: Record<string, { entity_id: string; name?: string; score: number }[] | unknown>;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

export interface InsightsResponse {
  success?: boolean;
  results: { entities?: QlooEntity[]; heatmap?: HeatmapCell[]; tags?: QlooTag[] };
  query?: Record<string, unknown>;
  duration?: number;
}

export interface HeatmapCell {
  location: { latitude: number; longitude: number; geohash: string };
  query: { affinity: number; affinity_rank?: number; popularity?: number; [k: string]: unknown };
}

export interface SearchResponse {
  results: QlooEntity[];
}

export interface TagsResponse {
  results: { tags: QlooTag[] };
}

/** Build a client from process.env (server-side only). */
export function qlooFromEnv(onCall?: (log: QlooCallLog) => void, o: { deadline?: number } = {}): QlooClient {
  return new QlooClient({ apiKey: process.env.QLOO_API_KEY ?? "", baseUrl: process.env.QLOO_BASE_URL || undefined, onCall, deadline: o.deadline });
}
