import pytest

import architecture as arch

ROUTE_A = '''/** GET /api/a — Lists the things. Second sentence is dropped. */
export async function GET() {}
/** Creates a thing | with a pipe. */
export async function POST() {}
export async function DELETE() {}
'''
ROUTE_B = "export async function PATCH() {}\nexport function NOT_A_ROUTE() {}\n"


def write(root, rel, text):
    p = root / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text)


@pytest.fixture
def tree(tmp_path, monkeypatch):
    write(tmp_path, "app/api/a/route.ts", ROUTE_A)
    write(tmp_path, "app/api/b/[id]/route.ts", ROUTE_B)
    write(tmp_path, "app/page.tsx", "")
    write(tmp_path, "app/cases/[id]/page.tsx", "")
    write(tmp_path, "next.config.ts", 'rewrites: [{ source: "/about", destination: "/about.html" }, { source: "/x", destination: "/nothtml" }]')
    write(tmp_path, "lib/plan.ts", '/** Plans the week. More text. */\nconst r = q.insights({ "filter.tags": 1, "signal.interests.entities": 2 });\n')
    write(tmp_path, "lib/replan.ts", 'q.entities(["a"]); q.search(1); q.tags(1);\nconst x = "filter.type";\n')
    write(tmp_path, "lib/gate.ts", "// no calls here\nconst y = 1;\n")
    write(tmp_path, "lib/agent.ts", "const t = {\n  search_places: tool({\n  }),\n  swap: tool({\n  }),\n  search_places: tool({\n  }),\n};\n")
    write(tmp_path, "lib/service.ts", "")
    write(tmp_path, "lib/resolve.ts", 'q.tags(1); q.search(2); const z = "filter.query"; const only = "bias.trends";\n')
    write(tmp_path, "lib/intake.ts", "")
    write(tmp_path, "lib/health.ts", "")
    write(tmp_path, "lib/venue.ts", "")
    write(tmp_path, "lib/verify.ts", "/**\n * Verifier.\n *   R-OPEN  open at the slot | really\n *   R-ALC   no alcohol\n * not a rule\n */\n")
    write(tmp_path, "README.md", "intro\n<!-- arch:qloo:start -->\nold\n<!-- arch:qloo:end -->\ntail\n")
    write(tmp_path, "ARCHITECTURE.md", "# A\n<!-- generated:start -->\nold\n<!-- generated:end -->\nfooter\n")
    monkeypatch.setattr(arch, "ROOT", tmp_path)
    monkeypatch.setattr(arch, "DOC", tmp_path / "ARCHITECTURE.md")
    monkeypatch.setattr(arch, "README", tmp_path / "README.md")
    return tmp_path


def test_first_sentence():
    assert arch.first_sentence("Hello   there.\n Next one.") == "Hello there"
    assert arch.first_sentence("no period at all") == "no period at all"
    assert arch.first_sentence("a | b.") == "a \\| b"
    long = "word " * 60 + "end."
    out = arch.first_sentence(long)
    assert out.endswith(" …") and len(out) <= 172
    assert arch.first_sentence("") == ""


def test_doc_comment_variants():
    src = "/** first */ a /** second\n * line two */ MARK b /** third */"
    assert arch.doc_comment(src) .strip() == "first"
    assert arch.doc_comment(src, "MARK") .strip() == "second line two"
    assert arch.doc_comment(src, "ABSENT") .strip() == "first"
    assert arch.doc_comment("no comments", "x") == ""
    assert arch.doc_comment("x MARK", "MARK") == ""


def test_routes_table(tree):
    rows = arch.routes()
    assert rows[2:] == [
        "| GET | `/api/a` | Lists the things |",
        "| POST | `/api/a` | Creates a thing \\| with a pipe |",
        "| DELETE | `/api/a` | Creates a thing \\| with a pipe |",  # no comment of its own: inherits the last block above it
        "| PATCH | `/api/b/:id` | — |",
    ]


def test_pages_table(tree):
    rows = arch.pages()
    assert "| `/` | `app/page.tsx` |" in rows
    assert "| `/cases/:id` | `app/cases/[id]/page.tsx` |" in rows
    assert "| `/about` | `public/about.html` (static; numbers written by `scripts/site.py`) |" in rows
    assert not any("/x`" in r for r in rows)


def test_modules_table(tree):
    rows = arch.modules()
    assert "| `lib/plan.ts` | 2 | Plans the week |" in rows
    assert "| `lib/service.ts` | 0 | — |" in rows


def test_rules_table(tree):
    assert arch.rules()[2:] == ["| `R-OPEN` | open at the slot \\| really |", "| `R-ALC` | no alcohol |"]
    assert arch.doc_comment_raw("no comment") == ""


def test_rules_without_header_comment(tree):
    write(tree, "lib/verify.ts", "export const x = 1;\n")
    assert arch.rules() == arch.rules()[:2]


def test_tools_dedupes_in_order(tree):
    assert arch.tools() == ["Tools offered to the model (`lib/agent.ts`): `search_places`, `swap`."]


def test_surface_and_split(tree):
    params, endpoints = arch.surface(["plan.ts", "gate.ts"])
    assert params == {"filter.tags", "signal.interests.entities"} and endpoints == {"/v2/insights"}
    q = arch.qloo_surface()
    assert q["product"] == (
        ["entity_ids", "filter.query", "filter.tags", "filter.type", "query", "signal.interests.entities", "types"],
        ["/entities", "/search", "/v2/insights", "/v2/tags"],
    )
    assert q["other"] == (["bias.trends"], [])
    assert q["all"][0] == sorted(set(q["product"][0]) | {"bias.trends"})


def test_ticks_and_qloo_text(tree):
    assert arch.ticks(["a", "b"]) == "`a`, `b`"
    lines = arch.qloo_params()
    assert lines[0].startswith("Plan loop") and "7 distinct Qloo parameters" in lines[0]
    assert "add no endpoint and 1 more parameters: `bias.trends`." in lines[2]
    assert "In all: 8 distinct parameters to 4 endpoints" in lines[4]


def test_qloo_text_with_extra_endpoint(tree):
    write(tree, "lib/venue.ts", "q.insights(1)\n")
    write(tree, "lib/plan.ts", "q.search(1)\n")
    write(tree, "lib/replan.ts", "")
    write(tree, "lib/resolve.ts", "")
    assert "add `/v2/insights` and 0 more parameters: ." in arch.qloo_params()[2]
    r = arch.readme_qloo()
    assert "to `/search`;" in r and "add `/v2/insights` and 0 more parameters (2 in all, to 2 endpoints)" in r


def test_generated_has_every_section(tree):
    g = arch.generated()
    for h in ("### HTTP routes", "### Pages", "### Modules", "### Verifier rules", "### Agent tools and Qloo surface"):
        assert h in g
    assert g.startswith("_Generated by `python3 scripts/architecture.py`")


def test_main_writes_then_check_passes_then_goes_stale(tree, monkeypatch, capsys):
    monkeypatch.setattr("sys.argv", ["architecture.py"])
    assert arch.main() == 0
    assert "regenerated" in capsys.readouterr().out
    doc = (tree / "ARCHITECTURE.md").read_text()
    assert doc.startswith("# A\n<!-- generated:start -->\n_Generated by") and doc.endswith("<!-- generated:end -->\nfooter\n")
    readme = (tree / "README.md").read_text()
    assert readme.startswith("intro\n<!-- arch:qloo:start -->\nThe plan loop") and readme.endswith("<!-- arch:qloo:end -->\ntail\n")

    monkeypatch.setattr("sys.argv", ["architecture.py", "--check"])
    assert arch.main() == 0
    assert "are current" in capsys.readouterr().out

    (tree / "lib" / "extra.ts").write_text("/** New module. */\n")
    assert arch.main() == 1
    assert "stale" in capsys.readouterr().err
    assert "extra.ts" not in (tree / "ARCHITECTURE.md").read_text()  # --check never writes


def test_check_flags_stale_readme_only(tree, monkeypatch, capsys):
    monkeypatch.setattr("sys.argv", ["architecture.py"])
    arch.main()
    (tree / "README.md").write_text((tree / "README.md").read_text().replace("The plan loop", "A plan loop"))
    monkeypatch.setattr("sys.argv", ["architecture.py", "--check"])
    assert arch.main() == 1
    capsys.readouterr()


def test_readme_without_markers_is_left_alone(tree, monkeypatch, capsys):
    (tree / "README.md").write_text("no markers\n")
    monkeypatch.setattr("sys.argv", ["architecture.py"])
    assert arch.main() == 0
    assert (tree / "README.md").read_text() == "no markers\n"


@pytest.mark.parametrize("doc", ["no markers", "<!-- generated:start --> only start", "only <!-- generated:end -->"])
def test_missing_doc_markers(tree, monkeypatch, capsys, doc):
    (tree / "ARCHITECTURE.md").write_text(doc)
    monkeypatch.setattr("sys.argv", ["architecture.py"])
    assert arch.main() == 1
    assert "has no generated markers" in capsys.readouterr().err
    assert (tree / "ARCHITECTURE.md").read_text() == doc


def test_real_repo_untouched_by_module_constants():
    # the fixture never leaks: the module's own ROOT is still the real repo unless monkeypatched
    assert (arch.ROOT / "scripts" / "architecture.py").exists()
