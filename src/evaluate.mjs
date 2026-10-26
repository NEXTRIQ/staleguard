// Turns probe results plus the previous state into alert events. Pure function.
//
// Alerting is edge-triggered: one "stale" event when a check goes stale, one "recovered" event when it comes
// back, and optionally a "reminder" every remindEvery while it stays stale. A check that was never seen before
// and is fresh produces nothing; one that starts out stale alerts immediately.

/**
 * prev: { [name]: { status, since, notifiedAt } }
 * Returns { next, events: [{ type: "stale" | "recovered" | "reminder", result, since }] }.
 */
export function evaluate(results, prev, { now, remindEveryMs = null }) {
  const nowIso = now.toISOString();
  const next = {};
  const events = [];
  for (const r of results) {
    const before = prev[r.name];
    if (r.status === "fresh") {
      if (before?.status === "stale") events.push({ type: "recovered", result: r, since: before.since });
      next[r.name] = { status: "fresh", since: before?.status === "fresh" ? before.since : nowIso, notifiedAt: null };
      continue;
    }
    if (before?.status !== "stale") {
      // "unknown" = went stale earlier but the alert could not be delivered; keep the original start time.
      const since = before?.status === "unknown" && before.since ? before.since : nowIso;
      events.push({ type: "stale", result: r, since });
      next[r.name] = { status: "stale", since, notifiedAt: nowIso };
      continue;
    }
    const due = remindEveryMs !== null && (!before.notifiedAt || now - new Date(before.notifiedAt) >= remindEveryMs);
    if (due) events.push({ type: "reminder", result: r, since: before.since });
    next[r.name] = { status: "stale", since: before.since, notifiedAt: due ? nowIso : before.notifiedAt };
  }
  return { next, events };
}

/** Marks events whose notification failed as not notified, so the next run retries them. */
export function unmarkFailed(next, prev, failed) {
  for (const e of failed) {
    const name = e.result.name;
    if (e.type === "recovered") next[name] = { ...prev[name] };
    else if (e.type === "stale") next[name] = { ...next[name], status: "unknown", notifiedAt: null };
    else next[name] = { ...next[name], notifiedAt: prev[name]?.notifiedAt ?? null };
  }
  return next;
}
