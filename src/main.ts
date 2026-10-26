// One staleguard run: probe every check, decide which alerts are due, deliver them, persist state.
import { evaluate, unmarkFailed } from "./evaluate.js";
import { composeText, sendTelegram, sendWebhook, webhookPayload } from "./notify.js";
import { probe } from "./probe.js";
import { loadState, saveState } from "./state.js";
import type { AlertEvent, Config, DeliveryFailure, Fetch, ProbeIo, ProbeResult } from "./types.js";

export interface RunDeps {
  readonly now?: Date;
  /** I/O for the probes. */
  readonly io?: Partial<ProbeIo>;
  /** HTTP client for alerts and the heartbeat. */
  readonly fetch?: Fetch;
  readonly log?: (line: string) => void;
  /** Probe and log, but send nothing and store no state. */
  readonly dryRun?: boolean;
}

export interface RunResult {
  /** Every check fresh and every alert delivered. */
  readonly ok: boolean;
  readonly results: readonly ProbeResult[];
  readonly events: readonly AlertEvent[];
  readonly failed: readonly DeliveryFailure[];
}

/** The single JSON line each run logs. */
export interface RunSummary {
  readonly at: string;
  readonly dryRun: boolean;
  readonly checks: number;
  readonly stale: readonly string[];
  /** "<type>:<check name>" */
  readonly events: readonly string[];
  readonly deliveryFailures: number;
}

/** Sends one event over every configured channel. Resolves to false if any channel failed. */
async function deliver(
  cfg: Config,
  event: AlertEvent,
  now: Date,
  fetchImpl: Fetch,
): Promise<boolean> {
  const ctx = { now, hostLabel: cfg.hostLabel };
  const sends: Promise<void>[] = [];
  if (cfg.telegram) sends.push(sendTelegram(cfg.telegram, composeText(event, ctx), fetchImpl));
  if (cfg.webhookUrl) {
    sends.push(sendWebhook(cfg.webhookUrl, webhookPayload(event, ctx), fetchImpl));
  }
  const outcomes = await Promise.allSettled(sends);
  // With no channel configured the run still reports through its exit code and log line.
  return outcomes.every((o) => o.status === "fulfilled");
}

export async function run(cfg: Config, deps: RunDeps = {}): Promise<RunResult> {
  const now = deps.now ?? new Date();
  const fetchImpl = deps.fetch ?? fetch;
  const log = deps.log ?? ((line: string) => void process.stdout.write(`${line}\n`));

  const results = await Promise.all(cfg.checks.map((c) => probe(c, { now, io: deps.io })));
  const prev = loadState(cfg.stateFile);
  const { next, events } = evaluate(results, prev, { now, remindEveryMs: cfg.remindEveryMs });

  const failed: DeliveryFailure[] = [];
  if (!deps.dryRun) {
    const undelivered: AlertEvent[] = [];
    // One event at a time, so alerts arrive in the order they were raised.
    for (const event of events) {
      if (!(await deliver(cfg, event, now, fetchImpl))) undelivered.push(event);
    }
    failed.push(...undelivered);
    saveState(cfg.stateFile, unmarkFailed(next, prev, undelivered));
    // Dead man's switch for staleguard itself: an external service alerts when these pings stop.
    // Only pinged when every check is fresh, so the external service also catches "staleguard runs but red".
    if (cfg.heartbeatUrl && results.every((r) => r.status === "fresh")) {
      const pinged = await fetchImpl(cfg.heartbeatUrl, {
        method: "GET",
        signal: AbortSignal.timeout(10_000),
      }).then(
        (res) => res.ok,
        () => false,
      );
      if (!pinged) failed.push({ type: "heartbeat" });
    }
  }

  const stale = results.filter((r) => r.status === "stale").map((r) => r.name);
  const summary: RunSummary = {
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
