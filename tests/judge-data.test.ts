import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadJudgeData } from "../lib/judge";
import { EMBER_MIN_MARGIN } from "../lib/replan";

/* a2a r09: /judge reads these committed files at request time, and the bench re-run regenerates every one of them. A
 * file whose shape drifted from what the page reads must render as "not run yet", never throw in the server component. */
const FILES = { bench: "results.json", replan: "replan.json", audit: "audit.json", predates: "predates.json", emberLive: "ember-live.json" } as const;

afterEach(() => vi.restoreAllMocks());

describe("committed bench files /judge reads", () => {
  it("a2a r09: every committed bench file parses against the shape /judge reads", async () => {
    const err = vi.spyOn(console, "error");
    const d = await loadJudgeData();
    for (const [k, f] of Object.entries(FILES)) if (existsSync(path.join("bench", f))) expect(d[k as keyof typeof FILES], f).not.toBeNull();
    expect(err).not.toHaveBeenCalled();
  });

  it("a2a r09: a drifted ember-live.json (no `distinct`) is null with the file named, never a throw", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const dir = mkdtempSync(path.join(tmpdir(), "judge-drift-"));
    writeFileSync(path.join(dir, "ember-live.json"), JSON.stringify({ generated_at: "t", definition: "d", threshold: 0.02, replans: 1 }));
    writeFileSync(path.join(dir, "predates.json"), "{ not json");
    const d = await loadJudgeData(dir);
    expect(d.emberLive).toBeNull();
    expect(d.predates).toBeNull();
    expect(err).toHaveBeenCalledWith(expect.stringContaining("ember-live.json"), expect.anything());
  });

  it("a2a r10: the ember counts /judge prints were computed at the margin it states (EMBER_MIN_MARGIN)", async () => {
    const d = await loadJudgeData();
    if (!d.emberLive) return;
    expect(d.emberLive.threshold).toBe(EMBER_MIN_MARGIN);
    expect(d.emberLive.definition).toContain(`>= ${EMBER_MIN_MARGIN}`);
  });

  it("a2a r10: every judge-facing statement of the ember margin is EMBER_MIN_MARGIN", () => {
    // DEMO.md's commit list (\`- \`<hash>\`\` lines) is history and keeps the margin each commit shipped with
    const files = ["README.md", "DEMO.md", "JUDGE.md", "public/about.html", "public/pitch.html"];
    const stated: string[] = [];
    for (const f of files)
      for (const line of readFileSync(f, "utf8").split("\n")) {
        if (/^- `[0-9a-f]{7}`/.test(line) || !/thread|original love|ember/i.test(line)) continue;
        for (const m of line.matchAll(/(?:at least|≥|>=|by|the)\s*(0\.0\d+)\b/g)) stated.push(`${f}: ${m[1]}`);
      }
    expect(stated.length).toBeGreaterThanOrEqual(5);
    for (const s of stated) expect(s).toMatch(new RegExp(`: ${EMBER_MIN_MARGIN}$`));
  });
});
