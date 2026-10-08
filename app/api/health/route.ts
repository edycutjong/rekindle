import { checkHealth, probeStore } from "@/lib/health";
import { json } from "@/lib/http";
import { llmChainFromEnv } from "@/lib/llm";
import { qlooFromEnv } from "@/lib/qloo";
import { guard } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

/** GET /api/health — Qloo + LLM liveness for the uptime pinger (?deep=1 also probes the Blob store): 200 when all answer, 503 otherwise. Never returns a key. */
export async function GET(req: Request) {
  const g = await guard(req, "health");
  if (g.deny) return g.deny;
  // a2a r02: the Blob head() is a billed simple op on Hobby, so only the (hourly) deep check spends it
  const deep = new URL(req.url).searchParams.get("deep") === "1";
  const h = await checkHealth({ qloo: () => qlooFromEnv(), llms: () => llmChainFromEnv(), store: process.env.BLOB_READ_WRITE_TOKEN ? "blob" : "memory", ...(deep ? { probeStore: () => probeStore(process.env.BLOB_READ_WRITE_TOKEN) } : {}) });
  return json(h, h.ok ? 200 : 503, g.headers);
}
