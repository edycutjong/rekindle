/**
 * Which store a request reads and writes. Bench runs (the `bench` namespace: `x-bench-token`) live under the `bench/`
 * prefix of the same private Blob store, so 100+ bench plans never crowd the public receipts on /integrations/qloo and
 * /judge, and a bench run cannot touch a visitor's case. Everyone else uses the product prefix.
 */
import { classify, type HasHeaders } from "./ratelimit";
import { storeFromEnv, type Store } from "./store";

export function storeFor(req: HasHeaders, env: Record<string, string | undefined> = process.env): Store {
  return storeFromEnv(env, classify(req, env) === "bench" ? "bench/" : "");
}
