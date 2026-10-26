// Probes one check and reports when it last succeeded. A probe never throws: any failure to read the signal is
// itself a finding, because "we could not tell" must never look like "all good".
import { readFile, stat } from "node:fs/promises";
import { isRecord, messageOf, prop } from "./guards.js";
import type { Check, Fetch, ProbeIo, ProbeResult } from "./types.js";

const FUTURE_TOLERANCE_MS = 5 * 60_000;
const MAX_BODY_BYTES = 256 * 1024;

export interface ProbeOptions {
  readonly now?: Date;
  /** Overrides for the real file system and network; missing members fall back to the real ones. */
  readonly io?: Partial<ProbeIo>;
}

/** Follows a dotted path ("status.lastOkAt") through own properties only, so "constructor" finds nothing. */
export function pick(obj: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>((v, key) => (isRecord(v) && Object.hasOwn(v, key) ? v[key] : undefined), obj);
}

/** ISO string, or epoch in seconds or milliseconds, to a Date. Anything else is null. */
export function toDate(value: unknown): Date | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Seconds stay below 1e12 until the year 33658; milliseconds passed it in 2001.
    return new Date(value < 1e12 ? value * 1000 : value);
  }
  if (typeof value === "string" && value.trim()) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

async function fetchJson(url: string, fetchImpl: Fetch): Promise<unknown> {
  const res = await fetchImpl(url, {
    headers: { accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_BODY_BYTES) throw new Error("response too large");
  return JSON.parse(text) as unknown;
}

async function lastSuccess(check: Check, io: ProbeIo): Promise<Date> {
  if (check.kind === "mtime") return (await io.stat(check.target)).mtime;
  const doc: unknown =
    check.kind === "file"
      ? JSON.parse(await io.readFile(check.target, "utf8"))
      : await fetchJson(check.target, io.fetch);
  const raw = pick(doc, check.field);
  if (raw === undefined || raw === null) {
    throw new Error(`field "${check.field}" is empty or missing`);
  }
  const at = toDate(raw);
  if (!at) throw new Error(`field "${check.field}" is not a timestamp`);
  return at;
}

/** A short, log-safe reason for a failed read. */
function describe(e: unknown): string {
  const code = prop(e, "code");
  if (code === "ENOENT") return "not found";
  if (code === "EACCES") return "permission denied";
  if (e instanceof SyntaxError) return "not valid JSON";
  if (prop(e, "name") === "TimeoutError") return "timed out";
  return messageOf(e).replace(/\s+/g, " ").slice(0, 120);
}

export async function probe(
  check: Check,
  { now = new Date(), io }: ProbeOptions = {},
): Promise<ProbeResult> {
  let at: Date;
  try {
    at = await lastSuccess(check, { readFile, stat, fetch, ...io });
  } catch (e) {
    return {
      name: check.name,
      lastOkAt: null,
      ageMs: null,
      status: "stale",
      reason: `cannot read signal: ${describe(e)}`,
    };
  }
  const ageMs = now.getTime() - at.getTime();
  const seen = { name: check.name, lastOkAt: at.toISOString(), ageMs };
  // A timestamp from the future usually means clock skew or a bug in the producer; do not trust it.
  if (ageMs < -FUTURE_TOLERANCE_MS) {
    return { ...seen, status: "stale", reason: "timestamp is in the future" };
  }
  if (ageMs > check.maxAgeMs) return { ...seen, status: "stale", reason: "older than maxAge" };
  return { ...seen, status: "fresh", reason: null };
}
