/**
 * LLM providers for the agent loop (OpenAI-compatible endpoints via the Vercel AI SDK).
 *
 *   qwen  qwen3.8-flash on DashScope-intl, always sent with `enable_thinking: false` (D1 spike: thinking on p50 9.5 s,
 *         off p50 1.0 s per call, 5/5 valid typed tool calls) and `parallel_tool_calls: true` when tools are offered
 *   groq  openai/gpt-oss-120b on Groq (needs a User-Agent header; p50 0.9 s in the D1 spike)
 *
 * `LLM_PROVIDER` picks the primary; the other one is the automatic fallback when its key is set. The model only routes
 * tools and writes coaching lines — truth comes from Qloo and lib/verify.ts — so a fast small model is enough.
 */
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

export type LlmProviderId = "qwen" | "groq";

export interface LlmHandle {
  provider: LlmProviderId;
  modelId: string;
  model: LanguageModel;
}

type FetchFn = typeof fetch;

const QWEN_DEFAULT_BASE = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
const GROQ_BASE = "https://api.groq.com/openai/v1";

export function makeLlm(provider: LlmProviderId, env: Record<string, string | undefined> = process.env, fetchImpl?: FetchFn): LlmHandle | null {
  if (provider === "qwen") {
    const apiKey = env.QWEN_API_KEY;
    if (!apiKey) return null;
    const modelId = env.QWEN_MODEL || "qwen3.8-flash";
    const p = createOpenAICompatible({
      name: "qwen",
      baseURL: env.QWEN_BASE_URL || QWEN_DEFAULT_BASE,
      apiKey,
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
      // thinking stays off on every call: a plan makes several LLM calls and the 15 s p50 budget cannot absorb 9.5 s each
      // DashScope returns one tool call per turn unless parallel_tool_calls is set; the agent routes 7 slots at once
      transformRequestBody: (body) => ({ ...body, enable_thinking: false, ...(body.tools ? { parallel_tool_calls: true } : {}) }),
    });
    return { provider, modelId, model: p.chatModel(modelId) };
  }
  const apiKey = env.GROQ_API_KEY;
  if (!apiKey) return null;
  const modelId = env.GROQ_MODEL || "openai/gpt-oss-120b";
  const p = createOpenAICompatible({
    name: "groq",
    baseURL: GROQ_BASE,
    apiKey,
    headers: { "User-Agent": "rekindle/0.1 (+https://github.com/edycutjong/rekindle)" },
    // gpt-oss returns reasoning that the SDK echoes back as `reasoning_content` on the next step, which Groq rejects
    // ("property 'reasoning_content' is unsupported", live run 2026-10-07); strip it and allow parallel tool calls
    transformRequestBody: (body) => ({
      ...body,
      ...(Array.isArray(body.messages) ? { messages: body.messages.map((m: Record<string, unknown>) => (m && "reasoning_content" in m ? Object.fromEntries(Object.entries(m).filter(([k]) => k !== "reasoning_content")) : m)) } : {}),
      ...(body.tools ? { parallel_tool_calls: true } : {}),
    }),
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
  return { provider, modelId, model: p.chatModel(modelId) };
}

/** Primary (LLM_PROVIDER, default qwen) first, then the other provider if its key is present. */
export function llmChainFromEnv(env: Record<string, string | undefined> = process.env, fetchImpl?: FetchFn): LlmHandle[] {
  const primary: LlmProviderId = env.LLM_PROVIDER === "groq" ? "groq" : "qwen";
  const secondary: LlmProviderId = primary === "qwen" ? "groq" : "qwen";
  return [makeLlm(primary, env, fetchImpl), makeLlm(secondary, env, fetchImpl)].filter((x): x is LlmHandle => x !== null);
}
