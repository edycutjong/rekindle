#!/usr/bin/env python3
"""Regenerate the code-derived tables in ARCHITECTURE.md (R6: architecture is read off the code, not the plan).

Rewrites everything between `<!-- generated:start -->` and `<!-- generated:end -->` from:
  - app/**/route.ts        HTTP method exports + the route's doc comment (first sentence)
  - app/**/page.tsx        pages
  - lib/*.ts               each module's header comment (first sentence) + line count
  - lib/verify.ts          the rule table in its header comment (R-ID … R-HIST)
  - lib/agent.ts           the typed tools offered to the model (`<name>: tool({`)
  - lib/*.ts that call the Qloo client   the Qloo endpoints + parameters, split into the plan loop (what
                                          /integrations/qloo shows) and intake / health / bench grader
  and the README line between `<!-- arch:qloo:start -->` and `<!-- arch:qloo:end -->`.

  python3 scripts/architecture.py          rewrite ARCHITECTURE.md in place
  python3 scripts/architecture.py --check  exit 1 if ARCHITECTURE.md is stale (no write)
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
DOC = ROOT / "ARCHITECTURE.md"
START, END = "<!-- generated:start -->", "<!-- generated:end -->"


def first_sentence(text: str) -> str:
    text = re.sub(r"\s+", " ", text).strip()
    m = re.match(r"(.+?\.)(\s|$)", text)
    s = (m.group(1) if m else text).rstrip(".")
    if len(s) > 170:
        s = s[:170].rsplit(" ", 1)[0] + " …"
    return s.replace("|", "\\|")


def doc_comment(src: str, before: str | None = None) -> str:
    """The /** … */ block (at the top, or the last one before `before`)."""
    if before and before in src:
        head = src[: src.index(before)]
        blocks = re.findall(r"/\*\*(.*?)\*/", head, re.S)
    else:
        blocks = re.findall(r"/\*\*(.*?)\*/", src, re.S)[:1]
    if not blocks:
        return ""
    lines = [re.sub(r"^\s*\* ?", "", l) for l in blocks[-1].splitlines()]
    return " ".join(l for l in lines if l.strip())


def route_path(p: pathlib.Path) -> str:
    rel = p.relative_to(ROOT / "app").parent.as_posix()
    return "/" + re.sub(r"\[(\w+)\]", r":\1", rel)


def routes() -> list[str]:
    rows = ["| Method | Path | What it does (from the route's doc comment) |", "|---|---|---|"]
    for p in sorted((ROOT / "app").rglob("route.ts")):
        src = p.read_text()
        for m in re.finditer(r"export async function (GET|POST|PATCH|PUT|DELETE)\b", src):
            desc = doc_comment(src, m.group(0))
            desc = re.sub(r"^(GET|POST|PATCH|PUT|DELETE) /\S+\s+[—-]\s+", "", desc.strip())
            rows.append(f"| {m.group(1)} | `{route_path(p)}` | {first_sentence(desc) or '—'} |")
    return rows


def pages() -> list[str]:
    rows = ["| Page | Source |", "|---|---|"]
    for p in sorted((ROOT / "app").rglob("page.tsx")):
        rel = p.relative_to(ROOT / "app").parent.as_posix()
        path = "/" if rel == "." else "/" + re.sub(r"\[(\w+)\]", r":\1", rel)
        rows.append(f"| `{path}` | `{p.relative_to(ROOT).as_posix()}` |")
    return rows


def modules() -> list[str]:
    rows = ["| Module | Lines | Role (first sentence of its header comment) |", "|---|---|---|"]
    for p in sorted((ROOT / "lib").glob("*.ts")):
        src = p.read_text()
        rows.append(f"| `lib/{p.name}` | {src.count(chr(10))} | {first_sentence(doc_comment(src)) or '—'} |")
    return rows


def rules() -> list[str]:
    src = (ROOT / "lib" / "verify.ts").read_text()
    rows = ["| Rule | Check (from `lib/verify.ts`) |", "|---|---|"]
    for m in re.finditer(r"^\s*\*\s+(R-[A-Z]+)\s+(.+)$", doc_comment_raw(src), re.M):
        rows.append(f"| `{m.group(1)}` | {m.group(2).strip().replace('|', chr(92) + '|')} |")
    return rows


def doc_comment_raw(src: str) -> str:
    m = re.search(r"/\*\*(.*?)\*/", src, re.S)
    return m.group(1) if m else ""


def tools() -> list[str]:
    src = (ROOT / "lib" / "agent.ts").read_text()
    names = list(dict.fromkeys(re.findall(r"^\s+(\w+): tool\(\{", src, re.M)))
    return [f"Tools offered to the model (`lib/agent.ts`): {', '.join(f'`{n}`' for n in names)}."]


# what each QlooClient method sends besides the params a caller passes (lib/qloo.ts)
METHOD = {"insights": ("/v2/insights", set()), "entities": ("/entities", {"entity_ids"}), "search": ("/search", {"query", "types"}), "tags": ("/v2/tags", {"filter.query"})}
# pagination / page-size keys are transport, not product depth: the same rule as lib/receipts.ts NOT_PRODUCT, so the
# counts here and on /integrations/qloo use one definition (QA round 3: `take` was counted here and not there)
TRANSPORT = {"take", "page", "offset"}
# the judged loop: plan, re-plan, swap, constraint toggle (what /integrations/qloo shows)
PRODUCT = ["plan.ts", "replan.ts", "gate.ts", "agent.ts", "service.ts"]
# intake (/api/resolve), health (/api/health) and the bench-only venue grader (/api/verify-venue)
OTHER = ["resolve.ts", "intake.ts", "health.ts", "venue.ts"]


def surface(files: list[str]) -> tuple[set[str], set[str]]:
    params: set[str] = set()
    endpoints: set[str] = set()
    for name in files:
        src = (ROOT / "lib" / name).read_text()
        calls = set(re.findall(r"\.(insights|entities|search|tags)\(", src))
        if not calls:
            continue
        params |= set(re.findall(r'"((?:filter|signal|feature|output|operator|bias|diversify)\.[a-z_.]+)"', src))
        for c in calls:
            endpoints.add(METHOD[c][0])
            params |= METHOD[c][1]
    return params - TRANSPORT, endpoints


def qloo_surface() -> dict:
    pp, pe = surface(PRODUCT)
    op, oe = surface(OTHER)
    return {"product": (sorted(pp), sorted(pe)), "other": (sorted(op - pp), sorted(oe - pe)), "all": (sorted(pp | op), sorted(pe | oe))}


def ticks(xs) -> str:
    return ", ".join(f"`{x}`" for x in xs)


def qloo_params() -> list[str]:
    q = qloo_surface()
    (pp, pe), (op, oe), (ap, ae) = q["product"], q["other"], q["all"]
    return [
        f"Plan loop (plan, re-plan, swap, constraint toggle; `lib/plan.ts`, `lib/gate.ts`): {len(pp)} distinct Qloo parameters to {ticks(pe)}: {ticks(pp)}.",
        "",
        f"Intake (`lib/resolve.ts`, `lib/intake.ts`), health (`lib/health.ts`) and the bench-only venue grader (`lib/venue.ts`) add {ticks(oe) or 'no endpoint'} and {len(op)} more parameters: {ticks(op)}.",
        "",
        f"In all: {len(ap)} distinct parameters to {len(ae)} endpoints ({ticks(ae)}). Page-size and pagination keys (`take`, `page`, `offset`) are not counted, here or on /integrations/qloo.",
    ]


def readme_qloo() -> str:
    q = qloo_surface()
    (pp, pe), (op, oe), (ap, ae) = q["product"], q["other"], q["all"]
    return (
        f"The plan loop (every plan, re-plan, swap and toggle) can send up to {len(pp)} distinct Qloo parameters to {' and '.join(f'`{e}`' for e in pe)}; "
        "which ones a given plan sends depends on its constraints (quiet and wheelchair add `filter.tags`, a re-plan adds `/entities`), and "
        "[`/integrations/qloo`](https://rekindle.edycu.dev/integrations/qloo) counts what the latest live plans actually sent. "
        f"Intake, the health check and the bench grader add {' and '.join(f'`{e}`' for e in oe)} "
        f"and {len(op)} more parameters ({len(ap)} in all, to {len(ae)} endpoints). Both lists are generated from the code in "
        "[ARCHITECTURE.md](ARCHITECTURE.md#agent-tools-and-qloo-surface)."
    )


def generated() -> str:
    parts = [
        "_Generated by `python3 scripts/architecture.py` from the source tree. Do not edit by hand; re-run it._",
        "",
        "### HTTP routes",
        "",
        *routes(),
        "",
        "### Pages",
        "",
        *pages(),
        "",
        "### Modules",
        "",
        *modules(),
        "",
        "### Verifier rules",
        "",
        *rules(),
        "",
        "### Agent tools and Qloo surface",
        "",
        *tools(),
        "",
        *qloo_params(),
    ]
    return "\n".join(parts)


README = ROOT / "README.md"
RS, RE_ = "<!-- arch:qloo:start -->", "<!-- arch:qloo:end -->"


def main() -> int:
    readme = README.read_text()
    new_readme = readme[: readme.index(RS) + len(RS)] + "\n" + readme_qloo() + "\n" + readme[readme.index(RE_):] if RS in readme else readme
    doc = DOC.read_text()
    if START not in doc or END not in doc:
        print("ARCHITECTURE.md has no generated markers", file=sys.stderr)
        return 1
    new = doc[: doc.index(START) + len(START)] + "\n" + generated() + "\n" + doc[doc.index(END):]
    if "--check" in sys.argv:
        if new != doc or new_readme != readme:
            print("ARCHITECTURE.md or the README Qloo-surface line is stale: run python3 scripts/architecture.py", file=sys.stderr)
            return 1
        print("ARCHITECTURE.md and the README Qloo-surface line are current")
        return 0
    DOC.write_text(new)
    README.write_text(new_readme)
    print("ARCHITECTURE.md and README Qloo-surface line regenerated")
    return 0


if __name__ == "__main__":
    sys.exit(main())
