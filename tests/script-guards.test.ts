import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { assertListAllowed } from "../scripts/script-guards";

/** Runs scripts/store_guard.py's decision against a canned /api/health answer (a fake opener: no network). */
function guard(health: { status: number; body: string } | { error: string }, env: Record<string, string> = {}): { exit: string | null } {
  const py = `
import io, json, sys, urllib.error
sys.path.insert(0, 'scripts')
import store_guard as g
spec, env = json.loads(sys.argv[1]), json.loads(sys.argv[2])
def opener(req, timeout=30):
    assert req.full_url.endswith('/api/health'), req.full_url
    if 'error' in spec: raise urllib.error.URLError(spec['error'])
    if spec['status'] >= 400: raise urllib.error.HTTPError(req.full_url, spec['status'], 'x', {}, io.BytesIO(spec['body'].encode()))
    return io.BytesIO(spec['body'].encode())
try:
    g.require_redis('http://deployment.invalid', opener=opener, env=env)
    print(json.dumps({'exit': None}))
except SystemExit as e:
    print(json.dumps({'exit': str(e.code)}))
`;
  return JSON.parse(execFileSync("python3", ["-c", py, JSON.stringify(health), JSON.stringify(env)], { encoding: "utf8" }));
}
const body = (o: object) => JSON.stringify({ ok: true, ...o });

describe("QA round 4 (a2a r06): scripts cannot spend Blob ops by accident", () => {
  it("QA round 4 (a2a r06): ember-margins / backfill-superseded refuse to list() a Blob store unless ALLOW_BLOB_SCRIPT=1; Redis and memory pass", () => {
    expect(() => assertListAllowed({ kind: "blob" }, {})).toThrow(/refusing to list\(\) the Blob store/);
    expect(() => assertListAllowed({ kind: "blob" }, { ALLOW_BLOB_SCRIPT: "1" })).not.toThrow();
    expect(() => assertListAllowed({ kind: "redis" }, {})).not.toThrow();
    expect(() => assertListAllowed({ kind: "memory" }, {})).not.toThrow();
  });

  it("QA round 4 (a2a r06): bench / smoke runs proceed only when /api/health names Redis — the body is read on a 503 too", () => {
    expect(guard({ status: 200, body: body({ store: "redis" }) }).exit).toBeNull();
    expect(guard({ status: 503, body: body({ ok: false, store: "redis" }) }).exit).toBeNull(); // Qloo or the LLM down, store fine
    expect(guard({ status: 200, body: body({ store: "blob" }) }).exit).toMatch(/store is 'blob', not 'redis'/);
    expect(guard({ status: 503, body: body({ ok: false, store: "blob" }) }).exit).toMatch(/not 'redis'/);
    expect(guard({ status: 200, body: body({ store: "redis", storeDegraded: true }) }).exit).toMatch(/safe mode/);
    expect(guard({ status: 429, body: JSON.stringify({ error: "rate limited" }) }).exit).toMatch(/did not name a store/);
    expect(guard({ status: 502, body: "<html>bad gateway</html>" }).exit).toMatch(/HTTP 502/);
    expect(guard({ error: "connection refused" }).exit).toMatch(/did not name a store/);
    expect(guard({ status: 200, body: body({ store: "memory" }) }).exit).toMatch(/not 'redis'/);
    expect(guard({ status: 200, body: body({ store: "memory" }) }, { ALLOW_MEMORY_TARGET: "1" }).exit).toBeNull();
    expect(guard({ status: 200, body: body({ store: "blob" }) }, { ALLOW_MEMORY_TARGET: "1" }).exit).toMatch(/not 'redis'/);
  });
});
