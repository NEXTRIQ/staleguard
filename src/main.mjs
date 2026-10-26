// One staleguard run: probe every check, decide which alerts are due, deliver them, persist state.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { evaluate, unmarkFailed } from "./evaluate.mjs";
import { composeText, sendTelegram, sendWebhook, webhookPayload } from "./notify.mjs";
import { probe } from "./probe.mjs";

export function loadState(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed.checks === "object" ? parsed.checks : {};
  } catch (e) {
    if (e?.code === "ENOENT") return {};
    // A corrupt state file only costs us edge detection; every stale check simply alerts again.
    return {};
  }
}

export function saveState(file, checks) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o755 });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, checks }, null, 1)}\n`, { mode: 0o644 });
  renameSync(tmp, file);
}

/**
 * deps: { now?, io?, fetch?, log?(line), dryRun? }
 * Returns { ok, results, events, failed }. ok = every check fresh and every alert delivered.
 */
export async function run(cfg, deps = {}) {
  const now = deps.now ?? new Date();
  const fetchImpl = deps.fetch ?? fetch;
  const log = deps.log ?? ((s) => process.stdout.write(`${s}\n`));

  const results = await Promise.all(cfg.checks.map((c) => probe(c, { now, ...(deps.io ? { io: deps.io } : {}) })));
  const prev = loadState(cfg.stateFile);
  const { next, events } = evaluate(results, prev, { now, remindEveryMs: cfg.remindEveryMs });

  const failed = [];
  if (!deps.dryRun) {
    for (const event of events) {
      const ctx = { now, hostLabel: cfg.hostLabel };
      const sends = [];
      if (cfg.telegram) sends.push(sendTelegram(cfg.telegram, composeText(event, ctx), fetchImpl));
      if (cfg.webhookUrl) sends.push(sendWebhook(cfg.webhookUrl, webhookPayload(event, ctx), fetchImpl));
      const outcomes = await Promise.allSettled(sends);
      // With no channel configured the run still reports through its exit code and log line.
      if (outcomes.some((o) => o.status === "rejected")) failed.push(event);
    }
    saveState(cfg.stateFile, unmarkFailed(next, prev, failed));
    if (cfg.heartbeatUrl) {
      // Dead man's switch for staleguard itself: an external service alerts when these pings stop.
      // Only pinged when every check is fresh, so the external service also catches "staleguard runs but red".
      if (results.every((r) => r.status === "fresh")) {
        await fetchImpl(cfg.heartbeatUrl, { method: "GET", signal: AbortSignal.timeout(10_000) })
          .then((res) => {
            if (!res.ok) throw new Error(`heartbeat responded ${res.status}`);
          })
          .catch(() => failed.push({ type: "heartbeat" }));
      }
    }
  }

  const stale = results.filter((r) => r.status === "stale").map((r) => r.name);
  const summary = {
    at: now.toISOString(),
    dryRun: Boolean(deps.dryRun),
    checks: results.length,
    stale,
    events: events.map((e) => `${e.type}:${e.result.name}`),
    deliveryFailures: failed.length,
  };
  log(JSON.stringify(summary));
  return { ok: stale.length === 0 && failed.length === 0, results, events, failed };
}
