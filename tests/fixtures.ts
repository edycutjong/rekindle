/** Test-only loader for captured Qloo responses (fixtures/qloo_captured, dated). Never imported by the app. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { QlooEntity } from "../lib/qloo";

const DIR = join(__dirname, "..", "fixtures", "qloo_captured");
export const CAPTURE_DATE = "2026-10-07";

export function captured(name: string): QlooEntity[] {
  const body = JSON.parse(readFileSync(join(DIR, `${CAPTURE_DATE}-${name}.json`), "utf8"));
  return Array.isArray(body.results) ? body.results : body.results.entities;
}

export function byName(list: QlooEntity[], name: string): QlooEntity {
  const e = list.find((x) => x.name === name);
  if (!e) throw new Error(`fixture has no entity named ${name}`);
  return e;
}

export function capturedRaw<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(join(DIR, `${CAPTURE_DATE}-${name}.json`), "utf8")) as T;
}
