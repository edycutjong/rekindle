/**
 * Qloo client — typed GET wrapper for the hackathon API.
 *
 * - Base URL is pinned to https://hackathon.api.qloo.com (other hosts reject hackathon keys with 401).
 * - GET only (the hackathon guide documents /v2/insights as GET).
 * - One jittered retry on 429 / 5xx / network error / timeout; 8 s timeout per attempt.
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
}

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
  const b = body as Record<string, any> | null;
  if (!b) return 0;
  const r = b.results;
  if (Array.isArray(r)) return r.length;
  if (r && typeof r === "object") {
    for (const key of ["entities", "tags", "heatmap", "trends"]) {
      if (Array.isArray(r[key])) return r[key].length;
    }
  }
  return 0;
}

const RETRYABLE = (status: number) => status === 429 || status >= 500;

export class QlooClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly onCall?: (log: QlooCallLog) => void;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

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
  }

  async get<T = any>(path: string, params: QlooParams = {}): Promise<T> {
    const encoded = encodeParams(params);
    const url = `${this.baseUrl}${path}?${new URLSearchParams(encoded).toString()}`;
    const t0 = Date.now();
    let attempts = 0;
    let lastStatus = 0;
    let lastError = "";
    while (attempts < 2) {
      attempts++;
      try {
        const res = await this.fetchImpl(url, {
          method: "GET",
          headers: { "X-Api-Key": this.apiKey, Accept: "application/json" },
          signal: AbortSignal.timeout(this.timeoutMs),
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
      } catch (e) {
        lastStatus = 0;
        lastError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      }
      if (attempts < 2) await this.sleep(250 + Math.floor(this.random() * 500));
    }
    this.log(path, encoded, lastStatus, t0, 0, attempts, lastError);
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
export function qlooFromEnv(onCall?: (log: QlooCallLog) => void): QlooClient {
  return new QlooClient({ apiKey: process.env.QLOO_API_KEY ?? "", baseUrl: process.env.QLOO_BASE_URL || undefined, onCall });
}
