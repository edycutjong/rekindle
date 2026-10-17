import urllib.error

import pytest
from conftest import Resp, http_error

import store_guard as g


def test_health_reads_json_and_sets_headers():
    seen = {}

    def opener(req, timeout):
        seen["url"], seen["ua"], seen["timeout"] = req.full_url, req.get_header("User-agent"), timeout
        return Resp('{"store": "redis"}')

    assert g.health("https://app.example/", opener=opener, timeout=7) == {"store": "redis"}
    assert seen == {"url": "https://app.example/api/health", "ua": "rekindle-store-guard", "timeout": 7}


@pytest.mark.parametrize(
    "exc,expected",
    [
        (http_error(503, '{"ok": false, "store": "redis"}'), {"ok": False, "store": "redis"}),
        (http_error(502, "<html>bad gateway"), {"error": "HTTP 502"}),
        (urllib.error.URLError("boom"), {"error": "<urlopen error boom>"}),
        (TimeoutError("slow"), {"error": "slow"}),
    ],
)
def test_health_error_paths(exc, expected):
    def opener(req, timeout):
        raise exc

    assert g.health("http://x", opener=opener) == expected


def test_health_non_json_body_is_an_error():
    assert g.health("http://x", opener=lambda r, timeout: Resp("not json")) == {"error": "Expecting value: line 1 column 1 (char 0)"}


@pytest.mark.parametrize(
    "h,env,expected",
    [
        ({"store": "redis"}, {}, None),
        ({"store": "memory"}, {"ALLOW_MEMORY_TARGET": "1"}, None),
        ({"store": "memory"}, {}, "the deployment's store is 'memory', not 'redis'"),
        ({"store": "memory"}, {"ALLOW_MEMORY_TARGET": "0"}, "the deployment's store is 'memory', not 'redis'"),
        ({"store": "blob"}, {}, "the deployment's store is 'blob', not 'redis'"),
        ({"error": "HTTP 502"}, {}, "did not name a store (HTTP 502)"),
        ({}, {}, "did not name a store (no store field)"),
        ({"store": "redis", "storeDegraded": True}, {}, "safe mode"),
    ],
)
def test_refusal(h, env, expected):
    out = g.refusal(h, env)
    if expected is None:
        assert out is None
    else:
        assert out.startswith("refusing: ") and expected in out


def test_blob_refusal_names_the_cap():
    assert "2,000 advanced per rolling 30 days" in g.refusal({"store": "blob"}, {})


def test_require_redis_exits_with_reason_or_returns():
    ok = lambda req, timeout=30: Resp('{"store": "redis"}')
    assert g.require_redis("http://x", opener=ok, env={}) is None
    bad = lambda req, timeout=30: Resp('{"store": "blob"}')
    with pytest.raises(SystemExit) as e:
        g.require_redis("http://x", opener=bad, env={})
    assert "refusing" in str(e.value.code)
