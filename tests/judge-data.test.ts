import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadJudgeData } from "../lib/judge";

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
});
