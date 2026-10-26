// Narrowing helpers for values of unknown shape: parsed JSON and whatever a `catch` clause receives.

/** True for any non-null object. Arrays count too: like objects, they are indexable by string keys. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Reads one property of a value without assuming its shape (e.g. `code` on a caught error). */
export function prop(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

/** The message of a caught value, which need not be an Error. */
export function messageOf(error: unknown): string {
  return String(prop(error, "message") ?? error);
}
