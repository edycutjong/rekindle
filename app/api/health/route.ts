import { checkHealth } from "@/lib/health";
import { json } from "@/lib/http";
import { llmChainFromEnv } from "@/lib/llm";
import { qlooFromEnv } from "@/lib/qloo";
import { guard } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

/** GET /api/health — Qloo + LLM liveness for the uptime pinger: 200 when both answer, 503 otherwise. Never returns a key. */
export async function GET(req: Request) {
  const g = await guard(req, "health");
  if (g.deny) return g.deny;
  const h = await checkHealth({ qloo: () => qlooFromEnv(), llms: () => llmChainFromEnv(), store: process.env.BLOB_READ_WRITE_TOKEN ? "blob" : "memory" });
  return json(h, h.ok ? 200 : 503, g.headers);
}
