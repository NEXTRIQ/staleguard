// Loads and validates staleguard.json. Secrets never live in the config file; they come from the environment.
import { readFileSync } from "node:fs";
import { parseDuration } from "./duration.mjs";

export class ConfigError extends Error {}

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

function checkFrom(raw, i) {
  const where = `checks[${i}]`;
  if (!raw || typeof raw !== "object") throw new ConfigError(`${where} must be an object`);
  if (!NAME.test(raw.name ?? "")) throw new ConfigError(`${where}.name must match ${NAME}`);
  const sources = ["file", "url", "mtime"].filter((k) => raw[k] !== undefined);
  if (sources.length !== 1) throw new ConfigError(`${where} needs exactly one of: file, url, mtime`);
  const kind = sources[0];
  if (kind !== "mtime" && !raw.field) throw new ConfigError(`${where}.field is required for ${kind} checks`);
  if (kind === "url" && !/^https?:\/\//.test(raw.url)) throw new ConfigError(`${where}.url must be http(s)`);
  let maxAgeMs;
  try {
    maxAgeMs = parseDuration(raw.maxAge);
  } catch (e) {
    throw new ConfigError(`${where}.maxAge: ${e.message}`);
  }
  return Object.freeze({ name: raw.name, kind, target: raw[kind], field: raw.field ?? null, maxAgeMs });
}

/** Parses an already-loaded config object. */
export function parseConfig(raw, env = {}) {
  if (!raw || !Array.isArray(raw.checks) || raw.checks.length === 0) throw new ConfigError("config needs a non-empty \"checks\" array");
  const checks = raw.checks.map(checkFrom);
  const names = new Set();
  for (const c of checks) {
    if (names.has(c.name)) throw new ConfigError(`duplicate check name: ${c.name}`);
    names.add(c.name);
  }
  let remindEveryMs = null;
  if (raw.remindEvery !== undefined && raw.remindEvery !== null) {
    try {
      remindEveryMs = parseDuration(raw.remindEvery);
    } catch (e) {
      throw new ConfigError(`remindEvery: ${e.message}`);
    }
  }
  const telegram = env.STALEGUARD_TELEGRAM_BOT_TOKEN && env.STALEGUARD_TELEGRAM_CHAT_ID
    ? { token: env.STALEGUARD_TELEGRAM_BOT_TOKEN, chatId: env.STALEGUARD_TELEGRAM_CHAT_ID }
    : null;
  const webhookUrl = env.STALEGUARD_WEBHOOK_URL || null;
  if (webhookUrl && !/^https:\/\//.test(webhookUrl)) throw new ConfigError("STALEGUARD_WEBHOOK_URL must be https");
  const heartbeatUrl = env.STALEGUARD_HEARTBEAT_URL || raw.heartbeatUrl || null;
  if (heartbeatUrl && !/^https?:\/\//.test(heartbeatUrl)) throw new ConfigError("heartbeat URL must be http(s)");
  return Object.freeze({
    checks,
    remindEveryMs,
    stateFile: env.STALEGUARD_STATE_FILE || raw.stateFile || "/var/lib/staleguard/state.json",
    telegram,
    webhookUrl,
    heartbeatUrl,
    hostLabel: raw.hostLabel ? String(raw.hostLabel).slice(0, 64) : null,
  });
}

export function loadConfig(path, env = process.env) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new ConfigError(e?.code === "ENOENT" ? `config not found: ${path}` : `config is not valid JSON: ${path}`);
  }
  return parseConfig(raw, env);
}
