// Loads and validates staleguard.json. Secrets never live in the config file; they come from the environment.
import { readFileSync } from "node:fs";
import { parseDuration } from "./duration.js";
import { isRecord, messageOf, prop } from "./guards.js";
import type { Check, CheckKind, Config, Env, TelegramConfig } from "./types.js";

/** Invalid configuration. The CLI maps it to exit code 78 (EX_CONFIG). */
export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const KINDS = ["file", "url", "mtime"] as const satisfies readonly CheckKind[];
const HTTP_URL = /^https?:\/\//;
const HTTPS_URL = /^https:\/\//;
const DEFAULT_STATE_FILE = "/var/lib/staleguard/state.json";

function durationAt(where: string, input: unknown): number {
  // Durations are strings; anything else is reported in its JSON form, e.g. `invalid duration: "3600"`.
  const text =
    typeof input === "string"
      ? input
      : input === undefined || input === null
        ? ""
        : JSON.stringify(input);
  try {
    return parseDuration(text);
  } catch (e) {
    throw new ConfigError(`${where}: ${messageOf(e)}`);
  }
}

/** A falsy value means "not set"; anything else must be a string. */
function optionalString(value: unknown, what: string): string | null {
  if (!value) return null;
  if (typeof value !== "string") throw new ConfigError(`${what} must be a string`);
  return value;
}

/** A falsy value means "not configured"; anything else must be a string matching `pattern`. */
function optionalUrl(value: unknown, pattern: RegExp, message: string): string | null {
  if (!value) return null;
  if (typeof value !== "string" || !pattern.test(value)) throw new ConfigError(message);
  return value;
}

function checkFrom(raw: unknown, i: number): Check {
  const where = `checks[${i}]`;
  if (!isRecord(raw)) throw new ConfigError(`${where} must be an object`);
  const { name } = raw;
  if (typeof name !== "string" || !NAME.test(name)) {
    throw new ConfigError(`${where}.name must match ${NAME}`);
  }
  const [kind, ...more] = KINDS.filter((k) => raw[k] !== undefined);
  if (kind === undefined || more.length > 0) {
    throw new ConfigError(`${where} needs exactly one of: file, url, mtime`);
  }
  if (kind !== "mtime" && !raw.field) {
    throw new ConfigError(`${where}.field is required for ${kind} checks`);
  }
  const target = raw[kind];
  if (typeof target !== "string") throw new ConfigError(`${where}.${kind} must be a string`);
  if (kind === "url" && !HTTP_URL.test(target)) {
    throw new ConfigError(`${where}.url must be http(s)`);
  }
  const maxAgeMs = durationAt(`${where}.maxAge`, raw.maxAge);
  return kind === "mtime"
    ? Object.freeze({ name, kind, target, field: null, maxAgeMs })
    : Object.freeze({ name, kind, target, field: String(raw.field), maxAgeMs });
}

/** Validates an already-parsed config object. `env` supplies secrets and overrides. */
export function parseConfig(raw: unknown, env: Env = {}): Config {
  if (!isRecord(raw) || !Array.isArray(raw.checks) || raw.checks.length === 0) {
    throw new ConfigError('config needs a non-empty "checks" array');
  }
  const checks = raw.checks.map(checkFrom);
  const names = new Set<string>();
  for (const c of checks) {
    if (names.has(c.name)) throw new ConfigError(`duplicate check name: ${c.name}`);
    names.add(c.name);
  }
  const remindEveryMs =
    raw.remindEvery === undefined || raw.remindEvery === null
      ? null
      : durationAt("remindEvery", raw.remindEvery);
  const telegram: TelegramConfig | null =
    env.STALEGUARD_TELEGRAM_BOT_TOKEN && env.STALEGUARD_TELEGRAM_CHAT_ID
      ? { token: env.STALEGUARD_TELEGRAM_BOT_TOKEN, chatId: env.STALEGUARD_TELEGRAM_CHAT_ID }
      : null;
  const webhookUrl = optionalUrl(
    env.STALEGUARD_WEBHOOK_URL,
    HTTPS_URL,
    "STALEGUARD_WEBHOOK_URL must be https",
  );
  const heartbeatUrl = optionalUrl(
    env.STALEGUARD_HEARTBEAT_URL || raw.heartbeatUrl,
    HTTP_URL,
    "heartbeat URL must be http(s)",
  );
  const stateFile =
    optionalString(env.STALEGUARD_STATE_FILE || raw.stateFile, "stateFile") ?? DEFAULT_STATE_FILE;
  const hostLabel = optionalString(raw.hostLabel, "hostLabel");
  return Object.freeze({
    checks,
    remindEveryMs,
    stateFile,
    telegram,
    webhookUrl,
    heartbeatUrl,
    hostLabel: hostLabel === null ? null : hostLabel.slice(0, 64),
  });
}

/** Reads and validates a config file. Unreadable or malformed files raise a ConfigError. */
export function loadConfig(path: string, env: Env = process.env): Config {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new ConfigError(
      prop(e, "code") === "ENOENT"
        ? `config not found: ${path}`
        : `config is not valid JSON: ${path}`,
    );
  }
  return parseConfig(raw, env);
}
