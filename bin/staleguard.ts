#!/usr/bin/env node
// staleguard CLI.
//   staleguard [--config <file>] [--dry-run]   probe all checks, alert on changes
//   staleguard status [--config <file>]        print every check's current freshness as JSON (never alerts)
//
// Exit codes: 0 all fresh and delivered, 1 stale or undelivered, 2 unexpected error, 78 configuration error.
import { ConfigError, loadConfig } from "../src/config.js";
import { formatAge } from "../src/duration.js";
import { messageOf } from "../src/guards.js";
import { run } from "../src/main.js";
import { probe } from "../src/probe.js";

const EX_CONFIG = 78;
const DEFAULT_CONFIG = "/etc/staleguard/staleguard.json";

const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(name);
const opt = (name: string, fallback: string): string => {
  const i = args.indexOf(name);
  return (i >= 0 ? args[i + 1] : undefined) || fallback;
};

async function main(): Promise<void> {
  const first = args[0];
  const cmd = first && !first.startsWith("--") ? first : "run";
  const cfg = loadConfig(opt("--config", process.env.STALEGUARD_CONFIG || DEFAULT_CONFIG));
  if (cmd === "status") {
    const now = new Date();
    const results = await Promise.all(cfg.checks.map((c) => probe(c, { now })));
    for (const r of results) {
      const age = r.ageMs === null ? null : formatAge(r.ageMs);
      process.stdout.write(`${JSON.stringify({ ...r, age })}\n`);
    }
    process.exitCode = results.every((r) => r.status === "fresh") ? 0 : 1;
    return;
  }
  if (cmd !== "run") throw new ConfigError(`unknown command: ${cmd}`);
  const { ok } = await run(cfg, { dryRun: flag("--dry-run") });
  process.exitCode = ok ? 0 : 1;
}

main().catch((e: unknown) => {
  const config = e instanceof ConfigError;
  // Error text can echo a Telegram API URL; mask the bot token before it reaches the journal.
  const message = messageOf(e).replace(/(bot)\d+:[\w-]+/g, "$1<token>");
  process.stderr.write(`staleguard: ${config ? "configuration error: " : ""}${message}\n`);
  process.exit(config ? EX_CONFIG : 2);
});
