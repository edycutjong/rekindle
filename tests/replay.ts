/** Test-only Qloo replay client over captured responses (fixtures/qloo_captured, dated). Never imported by the app. */
import type { InsightsResponse, QlooClient, QlooParams } from "../lib/qloo";
import { QlooError } from "../lib/qloo";
import type { CaseRow } from "../lib/plan";
import { captured, capturedRaw } from "./fixtures";

export const MAYA: CaseRow = {
  label: "Maya",
  lon: -73.9571,
  lat: 40.7081,
  energy: 1,
  priceMax: 2,
  maxMeters: 1500,
  inRecovery: false,
  needQuiet: false,
  needWheelchair: false,
  loves: [
    { text: "Phoebe Bridgers", qlooId: "AFBC71A7-9439-4AB0-AB68-D14B11AAF836", kind: "entity", name: "Phoebe Bridgers" },
    { text: "Fleabag", qlooId: "878680F2-2C8D-4D7A-8288-BEA75D38A843", kind: "entity", name: "Fleabag" },
    { text: "ramen", qlooId: "urn:tag:genre:place:restaurant:ramen", kind: "tag" },
  ],
};

/** Replays captured responses by request shape (test-only; the app always calls Qloo live). */
export function replayClient(seen: QlooParams[] = [], failPlaces = false): QlooClient {
  const off = captured("maya-thu-recovery-off");
  const on = captured("maya-thu-recovery-on-14tags");
  const heat = capturedRaw<InsightsResponse>("maya-heatmap");
  return {
    async insights(p: QlooParams): Promise<InsightsResponse> {
      seen.push(p);
      const t = String(p["filter.type"]);
      if (t === "urn:heatmap") return heat;
      if (t === "urn:entity:place") {
        if (failPlaces) throw new QlooError("Qloo /v2/insights failed (503)", 503, "/v2/insights");
        const excluded = String(p["filter.exclude.entities"] ?? "").split(",");
        const exTags = p["filter.exclude.tags"];
        const pool = Array.isArray(exTags) && exTags.length > 0 ? on : off;
        // the captured pools are Thursday's; hours are checked per slot by the verifier, so other days may refuse
        return { results: { entities: pool.filter((e) => !excluded.includes(e.entity_id)) } };
      }
      const kind = t.replace("urn:entity:", "");
      return { results: { entities: captured(`athome-${kind}`) } };
    },
  } as unknown as QlooClient;
}

