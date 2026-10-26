#!/usr/bin/env node
// staleguard CLI.
//   staleguard [--config <file>] [--dry-run]   probe all checks, alert on changes
//   staleguard status [--config <file>]        print every check's current freshness as JSON (never alerts)
import { ConfigError, loadConfig } from "../src/config.mjs";
import { formatAge } from "../src/duration.mjs";
import { run } from "../src/main.mjs";
import { probe } from "../src/probe.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

async function main() {
  const cmd = args[0] && !args[0].startsWith("--") ? args[0] : "run";
  const cfg = loadConfig(opt("--config", process.env.STALEGUARD_CONFIG || "/etc/staleguard/staleguard.json"));
  if (cmd === "status") {
    const now = new Date();
    const results = await Promise.all(cfg.checks.map((c) => probe(c, { now })));
    for (const r of results) process.stdout.write(`${JSON.stringify({ ...r, age: r.ageMs === null ? null : formatAge(r.ageMs) })}\n`);
    process.exitCode = results.every((r) => r.status === "fresh") ? 0 : 1;
    return;
  }
  if (cmd !== "run") throw new ConfigError(`unknown command: ${cmd}`);
  const { ok } = await run(cfg, { dryRun: flag("--dry-run") });
  process.exitCode = ok ? 0 : 1;
}

main().catch((e) => {
  const config = e instanceof ConfigError;
  process.stderr.write(`staleguard: ${config ? "configuration error: " : ""}${String(e?.message ?? e).replace(/(bot)\d+:[\w-]+/g, "$1<token>")}\n`);
  process.exit(config ? 78 : 2);
});
