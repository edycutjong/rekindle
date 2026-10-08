/**
 * Liveness (`GET /api/health`): one cheap Qloo `/v2/tags` call, one tiny LLM ping and one Blob `head()` (a simple op).
 * Reports status and latency for each and never a key. Results are cached per instance for 60 s so an uptime pinger or
 * a refresh loop cannot turn the endpoint into a key-spending loop.
 */
import { generateText } from "ai";
import type { LlmHandle } from "./llm";
import type { QlooClient } from "./qloo";

export interface Probe {
  ok: boolean;
  ms: number;
  detail: string;
}

export interface Health {
  ok: boolean;
  at: string;
  qloo: Probe;
  llm: Probe & { provider: string | null; model: string | null };
  store: string;
  /** a2a r01: the store is probed, not named — a suspended Blob store (e.g. over plan quota) used to report ok */
  storeProbe: Probe;
  cached: boolean;
}

const short = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 160);

export async function probeQloo(qloo: QlooClient): Promise<Probe> {
  const t0 = Date.now();
  try {
    const r = await qloo.tags("bakery", { take: 1 });
    const n = r?.results?.tags?.length ?? 0;
    return { ok: n > 0, ms: Date.now() - t0, detail: n > 0 ? `/v2/tags → ${n} tag` : "/v2/tags returned no tags" };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, detail: short(e) };
  }
}

/** First provider that answers wins; the chain order is the agent's (primary, then fallback). */
export async function probeLlm(llms: LlmHandle[]): Promise<Health["llm"]> {
  const t0 = Date.now();
  if (llms.length === 0) return { ok: false, ms: 0, detail: "no LLM key configured", provider: null, model: null };
  const errors: string[] = [];
  for (const l of llms) {
    try {
      await generateText({ model: l.model, prompt: "Reply with the single word: ok", maxOutputTokens: 8, maxRetries: 0, abortSignal: AbortSignal.timeout(8000) });
      return { ok: true, ms: Date.now() - t0, detail: errors.length ? `fallback after: ${errors.join("; ")}` : "answered", provider: l.provider, model: l.modelId };
    } catch (e) {
      errors.push(`${l.provider}: ${short(e)}`);
    }
  }
  return { ok: false, ms: Date.now() - t0, detail: errors.join("; "), provider: null, model: null };
}

/** One Blob `head()` on a path that need not exist: a 404 means the store answered; anything else is a failure. */
export async function probeStore(token: string | undefined, head?: (path: string, o: { token: string }) => Promise<unknown>): Promise<Probe> {
  const t0 = Date.now();
  if (!token) return { ok: true, ms: 0, detail: "in-memory store" };
  try {
    const blob = await import("@vercel/blob");
    const h = head ?? ((path: string, o: { token: string }) => blob.head(path, o));
    await h("health/ping.json", { token }).catch((e: unknown) => {
      if (!(e instanceof blob.BlobNotFoundError)) throw e;
    });
    return { ok: true, ms: Date.now() - t0, detail: "blob store reachable" };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, detail: short(e) };
  }
}

let cache: { at: number; h: Health } | null = null;

export async function checkHealth(deps: { qloo: () => QlooClient; llms: () => LlmHandle[]; store: string; probeStore?: () => Promise<Probe> }, now = Date.now(), ttlMs = 60_000): Promise<Health> {
  if (cache && now - cache.at < ttlMs) return { ...cache.h, cached: true };
  let qlooProbe: Probe;
  try {
    qlooProbe = await probeQloo(deps.qloo());
  } catch (e) {
    qlooProbe = { ok: false, ms: 0, detail: short(e) };
  }
  const llm = await probeLlm(deps.llms());
  const storeProbe = deps.probeStore ? await deps.probeStore() : { ok: true, ms: 0, detail: "not probed" };
  const h: Health = { ok: qlooProbe.ok && llm.ok && storeProbe.ok, at: new Date(now).toISOString(), qloo: qlooProbe, llm, store: deps.store, storeProbe, cached: false };
  cache = { at: now, h };
  return h;
}

export function resetHealthCache() {
  cache = null;
}
