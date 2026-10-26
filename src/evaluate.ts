// Turns probe results plus the previous state into alert events. Pure function.
//
// Alerting is edge-triggered: one "stale" event when a check goes stale, one "recovered" event when it comes
// back, and optionally a "reminder" every remindEvery while it stays stale. A check that was never seen before
// and is fresh produces nothing; one that starts out stale alerts immediately.
import type { AlertEvent, CheckState, ProbeResult, StateMap } from "./types.js";

export interface EvaluateOptions {
  readonly now: Date;
  readonly remindEveryMs?: number | null;
}

export interface Evaluation {
  readonly next: Record<string, CheckState>;
  readonly events: readonly AlertEvent[];
}

/** Own entries only: a check named "constructor" must not find Object.prototype.constructor. */
const stateOf = (state: StateMap, name: string): CheckState | undefined =>
  Object.hasOwn(state, name) ? state[name] : undefined;

export function evaluate(
  results: readonly ProbeResult[],
  prev: StateMap,
  { now, remindEveryMs = null }: EvaluateOptions,
): Evaluation {
  const nowIso = now.toISOString();
  const next: Record<string, CheckState> = {};
  const events: AlertEvent[] = [];
  for (const r of results) {
    const before = stateOf(prev, r.name);
    if (r.status === "fresh") {
      if (before?.status === "stale") {
        events.push({ type: "recovered", result: r, since: before.since });
      }
      next[r.name] = {
        status: "fresh",
        since: before?.status === "fresh" ? before.since : nowIso,
        notifiedAt: null,
      };
      continue;
    }
    if (before?.status !== "stale") {
      // "unknown" = went stale earlier but the alert could not be delivered; keep the original start time.
      const since = before?.status === "unknown" && before.since ? before.since : nowIso;
      events.push({ type: "stale", result: r, since });
      next[r.name] = { status: "stale", since, notifiedAt: nowIso };
      continue;
    }
    const due =
      remindEveryMs !== null &&
      (!before.notifiedAt || now.getTime() - Date.parse(before.notifiedAt) >= remindEveryMs);
    if (due) events.push({ type: "reminder", result: r, since: before.since });
    next[r.name] = {
      status: "stale",
      since: before.since,
      notifiedAt: due ? nowIso : before.notifiedAt,
    };
  }
  return { next, events };
}

/** Marks events whose notification failed as not notified, so the next run retries them. Mutates `next`. */
export function unmarkFailed(
  next: Record<string, CheckState>,
  prev: StateMap,
  failed: readonly AlertEvent[],
): Record<string, CheckState> {
  for (const e of failed) {
    const name = e.result.name;
    const before = stateOf(prev, name);
    if (e.type === "recovered") {
      // A recovery always follows a stored "stale" state; restoring it makes the next run recover again.
      if (before) next[name] = { ...before };
      continue;
    }
    const current = next[name];
    // Always present: evaluate() stores a state for every result it raises an event for.
    if (!current) continue;
    next[name] =
      e.type === "stale"
        ? { ...current, status: "unknown", notifiedAt: null }
        : { ...current, notifiedAt: before?.notifiedAt ?? null };
  }
  return next;
}
