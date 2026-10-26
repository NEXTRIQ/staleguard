// Persists per-check alert state between runs, so alerts stay edge-triggered across timer invocations.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isRecord } from "./guards.js";
import type { CheckState, CheckStatus, StateMap } from "./types.js";

const isCheckStatus = (value: unknown): value is CheckStatus =>
  value === "fresh" || value === "stale" || value === "unknown";

/** Validates one stored entry; anything malformed is dropped and the check is treated as new. */
function toCheckState(value: unknown): CheckState | undefined {
  if (!isRecord(value) || !isCheckStatus(value.status) || typeof value.since !== "string") {
    return undefined;
  }
  const notifiedAt = typeof value.notifiedAt === "string" ? value.notifiedAt : null;
  return { status: value.status, since: value.since, notifiedAt };
}

/** Never throws: a missing or corrupt state file only costs edge detection, so stale checks alert again. */
export function loadState(file: string): StateMap {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
  if (!isRecord(parsed) || !isRecord(parsed.checks)) return {};
  // fromEntries defines own properties, so a "__proto__" key in the file cannot reach the prototype.
  return Object.fromEntries(
    Object.entries(parsed.checks).flatMap(([name, raw]) => {
      const state = toCheckState(raw);
      return state ? [[name, state] as const] : [];
    }),
  );
}

/** Writes atomically (temp file + rename), so a crash never leaves a half-written state file. */
export function saveState(file: string, checks: StateMap): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o755 });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, checks }, null, 1)}\n`, { mode: 0o644 });
  renameSync(tmp, file);
}
