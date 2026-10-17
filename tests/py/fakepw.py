"""An in-process stand-in for playwright.sync_api, just rich enough for the three browser scripts.

Every page/locator call is recorded in `World.log`; every *answer* (count, text, enabled, ...) comes from a lookup
table the test supplies, so a test states "the deployment shows N slot cards" instead of driving a browser.

Lookup: an answer table maps a selector to a value. Locator chains are written "parent#idx >> child#idx"; a key may be
the full chain, the last segment with its index ("[data-testid=love-chip]#0") or the bare last segment.
A value may be a callable (called with no args) so a test can change its answer between calls.
"""
import sys
import types


def _lookup(table, path, default):
    segs = path.split(" >> ")
    last = segs[-1]
    for key in (path, last, last.split("#")[0]):
        if key in table:
            v = table[key]
            return v() if callable(v) else v
    return default


class World:
    def __init__(self, counts=None, texts=None, lists=None, enabled=None, disabled=None, visible=None, evaluate=None):
        self.counts, self.texts, self.lists = counts or {}, texts or {}, lists or {}
        self.enabled, self.disabled, self.visible, self.evaluate = enabled or {}, disabled or {}, visible or {}, evaluate or {}
        self.log, self.pages, self.contexts, self.closed = [], [], [], False

    def calls(self, name):
        return [e for e in self.log if e[0] == name]


class Locator:
    def __init__(self, world, path):
        self.w, self.path = world, path

    def locator(self, sub):
        return Locator(self.w, f"{self.path} >> {sub}")

    def nth(self, i):
        return Locator(self.w, f"{self.path}#{i}")

    @property
    def first(self):
        return self.nth(0)

    def count(self):
        return _lookup(self.w.counts, self.path, 0)

    def inner_text(self):
        return _lookup(self.w.texts, self.path, "")

    def all_inner_texts(self):
        return list(_lookup(self.w.lists, self.path, []))

    def is_enabled(self):
        return _lookup(self.w.enabled, self.path, False)

    def is_disabled(self):
        return _lookup(self.w.disabled, self.path, False)

    def is_visible(self):
        return _lookup(self.w.visible, self.path, False)

    def _act(self, name, *a, **k):
        self.w.log.append((name, self.path, a, k))

    def click(self, *a, **k):
        self._act("loc.click", *a, **k)

    def fill(self, value, **k):
        self._act("loc.fill", value, **k)

    def select_option(self, *a, **k):
        self._act("loc.select_option", *a, **k)

    def wait_for(self, **k):
        self._act("loc.wait_for", **k)

    def scroll_into_view_if_needed(self, **k):
        self._act("loc.scroll", **k)


class Page:
    def __init__(self, world, viewport):
        self.w, self.viewport, self.url, self.handlers = world, viewport, "", {}

    def on(self, event, cb):
        self.handlers[event] = cb

    def locator(self, sel):
        return Locator(self.w, sel)

    def goto(self, url, **k):
        self.url = url
        self.w.log.append(("goto", url, k))

    def reload(self, **k):
        self.w.log.append(("reload", self.url, k))

    def evaluate(self, expr):
        self.w.log.append(("evaluate", expr))
        return _lookup(self.w.evaluate, expr, 0)

    def screenshot(self, path=None, **k):
        self.w.log.append(("screenshot", path, k))

    def emulate_media(self, **k):
        self.w.log.append(("emulate_media", k))

    def _simple(name):
        def f(self, *a, **k):
            self.w.log.append((name, *a, k))
        return f

    click = _simple("click")
    fill = _simple("fill")
    select_option = _simple("select_option")
    wait_for_url = _simple("wait_for_url")
    wait_for_selector = _simple("wait_for_selector")
    wait_for_function = _simple("wait_for_function")


class Context:
    def __init__(self, world, kw):
        self.w, self.kw = world, kw

    def new_page(self):
        pg = Page(self.w, self.kw.get("viewport"))
        self.w.pages.append(pg)
        return pg


class Browser:
    def __init__(self, world):
        self.w = world

    def new_context(self, **kw):
        self.w.contexts.append(kw)
        return Context(self.w, kw)

    def close(self):
        self.w.closed = True


def install(monkeypatch, world):
    """Make `from playwright.sync_api import sync_playwright` resolve to this fake."""

    class PW:
        class chromium:
            @staticmethod
            def launch():
                return Browser(world)

    class CM:
        def __enter__(self):
            return PW

        def __exit__(self, *a):
            return False

    pkg = types.ModuleType("playwright")
    sub = types.ModuleType("playwright.sync_api")
    sub.sync_playwright = lambda: CM()
    pkg.sync_api = sub
    monkeypatch.setitem(sys.modules, "playwright", pkg)
    monkeypatch.setitem(sys.modules, "playwright.sync_api", sub)
    return world


def parse_run(out):
    """Split a script's stdout into (the JSON result object, the PASS/FAIL lines after it)."""
    import json
    obj, end = json.JSONDecoder().raw_decode(out)
    return obj, [l for l in out[end:].splitlines() if l.strip()]
