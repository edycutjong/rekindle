import { checkHealth, probeRedis, probeStore, type Probe } from "@/lib/health";
import { json } from "@/lib/http";
import { llmChainFromEnv } from "@/lib/llm";
import { qlooFromEnv } from "@/lib/qloo";
import { guard } from "@/lib/ratelimit";
import { redisFromEnv, storeDegraded, storeFromEnv } from "@/lib/store";

export const dynamic = "force-dynamic";

/** the backend that serves this deployment's requests (storeFromEnv's precedence), and its deep probe */
function storeProbe(): { kind: string; probe: () => Promise<Probe> } {
  let kind: string;
  try {
    kind = storeFromEnv().kind;
  } catch {
    return { kind: "none", probe: async () => ({ ok: false, ms: 0, detail: "no store configured on this deployment" }) };
  }
  const redis = redisFromEnv();
  if (kind === "redis" && redis) return { kind, probe: () => probeRedis(() => redis.ping()) };
  return { kind, probe: () => probeStore(process.env.BLOB_READ_WRITE_TOKEN) };
}

/** GET /api/health — Qloo + LLM liveness for the uptime pinger (?deep=1 also probes the store): 200 when all answer, 503 otherwise. Never returns a key. */
export async function GET(req: Request) {
  const g = await guard(req, "health");
  if (g.deny) return g.deny;
  // a2a r02: the store probe is a billed op on Blob, so only the (hourly) deep check spends it; on Redis it is a PING
  const deep = new URL(req.url).searchParams.get("deep") === "1";
  const st = storeProbe();
  const h = await checkHealth({ qloo: () => qlooFromEnv(), llms: () => llmChainFromEnv(), store: st.kind, ...(deep ? { probeStore: st.probe } : {}) });
  // a2a r06: `storeDegraded` = this instance is in safe mode (its store refused; new weeks live in its memory).
  // a2a r07: safe mode is not healthy — a status-code-only uptime monitor must see it as a 503
  const degraded = storeDegraded();
  const ok = h.ok && !degraded;
  return json({ ...h, ok, storeDegraded: degraded }, ok ? 200 : 503, g.headers);
}
