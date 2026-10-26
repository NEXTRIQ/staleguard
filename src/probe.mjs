// Probes one check and reports when it last succeeded. A probe never throws: any failure to read the signal is
// itself a finding, because "we could not tell" must never look like "all good".
import { readFile, stat } from "node:fs/promises";

const FUTURE_TOLERANCE_MS = 5 * 60_000;
const MAX_BODY_BYTES = 256 * 1024;

/** Follows a dotted path ("status.lastOkAt") through plain objects. */
export function pick(obj, path) {
  return String(path)
    .split(".")
    .reduce((v, key) => (v !== null && typeof v === "object" && Object.hasOwn(v, key) ? v[key] : undefined), obj);
}

/** ISO string, or epoch in seconds or milliseconds, to a Date. Anything else is null. */
export function toDate(value) {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value < 1e12 ? value * 1000 : value);
  if (typeof value === "string" && value.trim()) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

async function fetchJson(url, fetchImpl) {
  const res = await fetchImpl(url, { headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_BODY_BYTES) throw new Error("response too large");
  return JSON.parse(text);
}

async function lastSuccess(check, io) {
  if (check.kind === "mtime") return (await io.stat(check.target)).mtime;
  const doc = check.kind === "file" ? JSON.parse(await io.readFile(check.target, "utf8")) : await fetchJson(check.target, io.fetch);
  const raw = pick(doc, check.field);
  if (raw === undefined || raw === null) throw new Error(`field "${check.field}" is empty or missing`);
  const at = toDate(raw);
  if (!at) throw new Error(`field "${check.field}" is not a timestamp`);
  return at;
}

const describe = (e) => {
  if (e?.code === "ENOENT") return "not found";
  if (e?.code === "EACCES") return "permission denied";
  if (e instanceof SyntaxError) return "not valid JSON";
  if (e?.name === "TimeoutError") return "timed out";
  return String(e?.message ?? e).replace(/\s+/g, " ").slice(0, 120);
};

/**
 * Returns { name, status: "fresh" | "stale", lastOkAt: ISO | null, ageMs: number | null, reason: string | null }.
 */
export async function probe(check, { now = new Date(), io = { readFile, stat, fetch } } = {}) {
  const base = { name: check.name, lastOkAt: null, ageMs: null };
  let at;
  try {
    at = await lastSuccess(check, io);
  } catch (e) {
    return { ...base, status: "stale", reason: `cannot read signal: ${describe(e)}` };
  }
  const ageMs = now - at;
  const result = { ...base, lastOkAt: at.toISOString(), ageMs };
  // A timestamp from the future usually means clock skew or a bug in the producer; do not trust it.
  if (ageMs < -FUTURE_TOLERANCE_MS) return { ...result, status: "stale", reason: "timestamp is in the future" };
  if (ageMs > check.maxAgeMs) return { ...result, status: "stale", reason: "older than maxAge" };
  return { ...result, status: "fresh", reason: null };
}
