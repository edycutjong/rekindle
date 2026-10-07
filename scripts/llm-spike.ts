/**
 * LLM spike: is the routing model served, does it return a valid typed tool call,
 * and what is its latency? Runs N identical tool-call requests per provider/variant and prints p50/p95.
 *
 * Decision rule (specs, D1): if qwen3.8-flash is not served or its p50 > 15 s, switch LLM_PROVIDER to groq.
 *
 *   QWEN_API_KEY=… GROQ_API_KEY=… npx tsx scripts/llm-spike.ts [--n 5] [--out spike/llm-spike.json]
 */
import { writeFileSync } from "node:fs";

type Variant = { label: string; baseUrl: string; key: string | undefined; model: string; extra?: Record<string, unknown>; headers?: Record<string, string> };

const args = process.argv.slice(2);
const N = Number(args[args.indexOf("--n") + 1] ?? 5) || 5;
const out = args.includes("--out") ? args[args.indexOf("--out") + 1] : undefined;

const tool = {
  type: "function",
  function: {
    name: "findAtHome",
    description: "Find at-home taste picks (entity-level) for the patient's 10-minute dose.",
    parameters: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["artist", "podcast", "book", "tv_show"] },
        take: { type: "integer", minimum: 3, maximum: 10 },
      },
      required: ["type", "take"],
    },
  },
};

const messages = [
  { role: "system", content: "You route a behavioral-activation planner. Call exactly one tool. Never name venues." },
  { role: "user", content: "Patient loved Phoebe Bridgers and Fleabag. Energy 1 (low). Pick the at-home domain for Monday's 10-minute dose." },
];

const variants: Variant[] = [
  { label: "qwen3.8-flash", baseUrl: process.env.QWEN_BASE_URL ?? "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", key: process.env.QWEN_API_KEY, model: "qwen3.8-flash" },
  { label: "qwen3.8-flash enable_thinking=false", baseUrl: process.env.QWEN_BASE_URL ?? "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", key: process.env.QWEN_API_KEY, model: "qwen3.8-flash", extra: { enable_thinking: false } },
  { label: "groq openai/gpt-oss-120b", baseUrl: "https://api.groq.com/openai/v1", key: process.env.GROQ_API_KEY, model: "openai/gpt-oss-120b", headers: { "User-Agent": "rekindle-spike/0.1" } },
];

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] : NaN;
};

async function once(v: Variant) {
  const t0 = performance.now();
  const res = await fetch(`${v.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${v.key}`, ...(v.headers ?? {}) },
    body: JSON.stringify({ model: v.model, messages, tools: [tool], tool_choice: "auto", ...(v.extra ?? {}) }),
    signal: AbortSignal.timeout(60_000),
  });
  const ms = Math.round(performance.now() - t0);
  const body = (await res.json().catch(() => ({}))) as any;
  const call = body?.choices?.[0]?.message?.tool_calls?.[0];
  let argsOk = false;
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(call?.function?.arguments ?? "null");
    const a = parsed as { type?: string; take?: number };
    argsOk = call?.function?.name === "findAtHome" && ["artist", "podcast", "book", "tv_show"].includes(a?.type ?? "") && Number.isInteger(a?.take) && a.take! >= 3 && a.take! <= 10;
  } catch {}
  return {
    status: res.status,
    ms,
    servedModel: body?.model ?? null,
    toolCallValid: argsOk,
    args: parsed,
    reasoningTokens: body?.usage?.completion_tokens_details?.reasoning_tokens ?? null,
    completionTokens: body?.usage?.completion_tokens ?? null,
    error: res.ok ? undefined : String(body?.error?.message ?? body?.message ?? res.statusText).slice(0, 200),
  };
}

async function main() {
  const report: Record<string, unknown> = { at: new Date().toISOString(), n: N, variants: [] as unknown[] };
  for (const v of variants) {
    if (!v.key) {
      console.log(`${v.label}: SKIPPED (no key in env)`);
      continue;
    }
    const runs = [];
    for (let i = 0; i < N; i++) runs.push(await once(v).catch((e) => ({ status: 0, ms: NaN, error: String(e).slice(0, 200) })));
    const ok = runs.filter((r: any) => r.status === 200);
    const lat = ok.map((r: any) => r.ms);
    const summary = {
      label: v.label,
      served: ok.length > 0,
      servedModel: (ok[0] as any)?.servedModel ?? null,
      ok: ok.length,
      validToolCalls: runs.filter((r: any) => r.toolCallValid).length,
      p50_ms: pct(lat, 50),
      p95_ms: pct(lat, 95),
      runs,
    };
    (report.variants as unknown[]).push(summary);
    console.log(`${v.label}: served=${summary.served} model=${summary.servedModel} ok=${summary.ok}/${N} validToolCalls=${summary.validToolCalls}/${N} p50=${summary.p50_ms}ms p95=${summary.p95_ms}ms`);
    const errs = runs.filter((r: any) => r.error).map((r: any) => r.error);
    if (errs.length) console.log(`  errors: ${[...new Set(errs)].join(" | ")}`);
  }
  if (out) writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
