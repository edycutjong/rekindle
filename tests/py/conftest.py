"""Shared helpers: run a run-at-import script under a fake argv / cwd, capture its exit code, and a canned urlopen."""
import io
import json
import runpy
import sys
import urllib.error

import pytest

SCRIPTS = __import__("pathlib").Path(__file__).resolve().parents[2] / "scripts"


def run_script(name, argv, monkeypatch):
    """Execute scripts/<name>.py as __main__ with sys.argv = [name, *argv]; returns the SystemExit code (None if it returned)."""
    monkeypatch.setattr(sys, "argv", [name + ".py", *argv])
    try:
        runpy.run_path(str(SCRIPTS / (name + ".py")), run_name="__main__")
    except SystemExit as e:
        return e.code
    return None


class Resp(io.BytesIO):
    """urlopen() result: context manager with .status, .headers, .read()."""

    def __init__(self, body, status=200, ctype="application/json"):
        super().__init__(body.encode() if isinstance(body, str) else body)
        self.status = status
        self.headers = {"content-type": ctype}

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def http_error(code, body="", ctype="application/json", url="http://x"):
    return urllib.error.HTTPError(url, code, "err", {"content-type": ctype}, io.BytesIO(body.encode()))


@pytest.fixture
def health_ok(monkeypatch):
    """Make store_guard.require_redis a no-op (the guard has its own tests)."""
    import store_guard
    monkeypatch.setattr(store_guard, "require_redis", lambda *a, **k: None)
    return store_guard
