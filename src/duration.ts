// Human durations ("90s", "15m", "1h30m", "2d") to milliseconds.

const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
type Unit = keyof typeof UNIT_MS;

const isUnit = (unit: string | undefined): unit is Unit =>
  unit !== undefined && Object.hasOwn(UNIT_MS, unit);

/** Throws a plain Error mentioning "duration" when the input is not a positive duration. */
export function parseDuration(input: string): number {
  const s = input.trim().toLowerCase();
  if (!s) throw new Error("empty duration");
  // Sticky: every part must start exactly where the previous one (plus spaces) ended.
  const part = /(\d+)\s*([smhd])/y;
  let total = 0;
  let consumed = 0;
  for (let m = part.exec(s); m; m = part.exec(s)) {
    const [, count, unit] = m;
    // The pattern guarantees both groups; this only narrows their types.
    if (count === undefined || !isUnit(unit)) break;
    total += Number(count) * UNIT_MS[unit];
    consumed = part.lastIndex;
    while (s[consumed] === " ") consumed++;
    part.lastIndex = consumed;
  }
  if (consumed !== s.length || total <= 0) {
    throw new Error(`invalid duration: "${input}" (use e.g. 90s, 15m, 1h30m, 2d)`);
  }
  return total;
}

/** Milliseconds to a short readable age: "47s", "12m", "3h 05m", "2d 4h". */
export function formatAge(ms: number): string {
  if (!Number.isFinite(ms)) return "unknown";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
