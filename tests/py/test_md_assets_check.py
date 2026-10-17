import subprocess
from types import SimpleNamespace

from conftest import run_script


def world(tmp_path, monkeypatch, files, tracked=None):
    for rel, text in files.items():
        p = tmp_path / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)
    tracked = list(files) if tracked is None else tracked
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(subprocess, "run", lambda cmd, **kw: SimpleNamespace(stdout="\n".join(tracked) + "\n"))
    return tracked


TEST_FILE = 'describe("x", () => {\n  it("first test title", () => {})\n  it(`say "hi" now`, () => {})\n  test.skip(\'third\', () => {})\n})\n'


def test_clean_repo_passes(tmp_path, monkeypatch, capsys):
    files = {
        "docs/img.png": "",
        "docs/a.md": '<img src="img.png">\n![ok](./img.png?raw=1#frag)\n[up](../tests)\n[web](https://x.com) [m](mailto:a@b.c) [abs](/abs) [anchor](#top) [ang](<a b>)\n',
        "tests/t.test.ts": TEST_FILE,
        "README.md": '[`tests/t.test.ts:2`](tests/t.test.ts#L2 "first test") and [`tests/t.test.ts:3`](tests/t.test.ts#L3 "say \'hi\'")\n[`tests/t.test.ts:4`](tests/t.test.ts#L4 "third")\n[dir](tests/)\n',
        "node_modules/pkg/readme.md": "![x](nope.png)\n",
        "notes.TXT": "![x](nope.png)",
    }
    tracked = world(tmp_path, monkeypatch, files)
    assert run_script("md_assets_check", [], monkeypatch) is None
    out = capsys.readouterr().out
    assert "every local link in 2 tracked Markdown files resolves" in out
    assert tracked  # sanity


def test_broken_links_and_bad_test_refs(tmp_path, monkeypatch, capsys):
    files = {
        "docs/img.png": "",
        "docs/a.md": "![x](missing.png)\n[`tests/t.test.ts:2`] bare mention tests/t.test.ts:2\n",
        "tests/t.test.ts": TEST_FILE,
        "README.md": "\n".join(
            [
                '[`tests/t.test.ts:2`](tests/t.test.ts#L3 "first test")',  # links to another line
                '[`tests/t.test.ts:1`](tests/t.test.ts#L1 "x")',  # describe(...) is not a test start
                '[`tests/t.test.ts:2`](tests/t.test.ts#L2 "third")',  # opens another test; "third" is at line 4
                '[`tests/t.test.ts:2`](tests/t.test.ts#L2 "nowhere")',  # no such title
                '[`tests/t.test.ts:99`](tests/t.test.ts#L99 "z")',  # out of range
                '[`tests/gone.ts:1`](tests/gone.ts#L1 "t")',  # untracked file
                "[`tests/t.test.ts:2`] only",  # not a titled link
            ]
        )
        + "\n",
    }
    world(tmp_path, monkeypatch, files)
    assert run_script("md_assets_check", [], monkeypatch) == 1
    cap = capsys.readouterr()
    out = cap.out
    assert "docs/a.md:1: missing.png is not a tracked file" in out
    assert 'docs/a.md:2: cite a test as [`tests/<file>.ts:N`]' in out
    assert "README.md:1: tests/t.test.ts:2 links to tests/t.test.ts#L3" in out
    assert "README.md:2: tests/t.test.ts:1 is not the start of a test ('describe(\"x\", () => {')" in out
    assert "README.md:3: tests/t.test.ts:2 opens another test ('first test title'); \"third…\" is at [4]" in out
    assert "README.md:4: tests/t.test.ts:2 opens another test ('first test title'); \"nowhere…\" is at no line" in out
    assert "README.md:5: tests/t.test.ts:99 is not the start of a test ('')" in out
    assert "README.md:6: tests/gone.ts:1 is not the start of a test ('')" in out
    assert "README.md:6: tests/gone.ts is not a tracked file" in out
    assert "README.md:7: cite a test" in out
    assert "Markdown reference(s) point at an untracked file or off a test" in cap.err


def test_parent_escape_at_root_is_untracked(tmp_path, monkeypatch, capsys):
    world(tmp_path, monkeypatch, {"README.md": "[x](../../outside.md)\n"})
    assert run_script("md_assets_check", [], monkeypatch) == 1
    assert "README.md:1: ../../outside.md is not a tracked file" in capsys.readouterr().out
