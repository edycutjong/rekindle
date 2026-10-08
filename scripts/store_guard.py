"""a2a r06 F5: scripts that write many plans (bench.py, ui_smoke.py) refuse to run unless the target deployment's
store is Upstash Redis. On Vercel Hobby a Blob store allows 2,000 advanced ops per rolling 30 days and locks for 30
days past that; one bench run needs 350+. /api/health names the store and answers 503 when Qloo or the LLM is down,
so the body is read either way. Stdlib only.

A local target on the in-memory store (no Blob possible) is allowed only with ALLOW_MEMORY_TARGET=1."""
import json, os, sys, urllib.error, urllib.request


def health(base, opener=urllib.request.urlopen, timeout=30):
    req = urllib.request.Request(base.rstrip("/") + "/api/health", headers={"user-agent": "rekindle-store-guard", "accept": "application/json"})
    try:
        with opener(req, timeout=timeout) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        try:
            return json.load(e)
        except ValueError:
            return {"error": f"HTTP {e.code}"}
    except (urllib.error.URLError, OSError, ValueError) as e:
        return {"error": str(e)}


def refusal(h, env=os.environ):
    """None when the run may proceed, else the reason it may not."""
    store = h.get("store")
    if store == "memory" and env.get("ALLOW_MEMORY_TARGET") == "1":
        return None
    if store != "redis":
        why = f"the deployment's store is {store!r}, not 'redis'" if store else f"/api/health did not name a store ({h.get('error') or 'no store field'})"
        return f"refusing: {why}. Blob ops are capped on Vercel Hobby (2,000 advanced per rolling 30 days, then a 30-day lockout)."
    if h.get("storeDegraded"):
        return "refusing: the deployment's store is in safe mode (Redis refused; new weeks live in instance memory). Try again later."
    return None


def require_redis(base, opener=urllib.request.urlopen, env=os.environ):
    why = refusal(health(base, opener), env)
    if why:
        sys.exit(why)
