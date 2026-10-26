// Domain types shared across modules. Everything that crosses a module boundary is readonly.

/** Where a check reads its last-success signal from. */
export type CheckKind = "file" | "url" | "mtime";

interface CheckBase {
  readonly name: string;
  /** Path for "file" and "mtime", URL for "url". */
  readonly target: string;
  readonly maxAgeMs: number;
}

/** A timestamp inside a JSON document, found by a dotted path. */
export interface FieldCheck extends CheckBase {
  readonly kind: "file" | "url";
  readonly field: string;
}

/** The modification time of a file. */
export interface MtimeCheck extends CheckBase {
  readonly kind: "mtime";
  readonly field: null;
}

export type Check = FieldCheck | MtimeCheck;

export interface TelegramConfig {
  readonly token: string;
  readonly chatId: string;
}

export interface Config {
  readonly checks: readonly Check[];
  readonly remindEveryMs: number | null;
  readonly stateFile: string;
  readonly telegram: TelegramConfig | null;
  readonly webhookUrl: string | null;
  readonly heartbeatUrl: string | null;
  readonly hostLabel: string | null;
}

/** The subset of `process.env` staleguard reads. */
export type Env = Readonly<Record<string, string | undefined>>;

/** A signal was read and is recent enough. */
export interface FreshResult {
  readonly name: string;
  /** ISO 8601. */
  readonly lastOkAt: string;
  readonly ageMs: number;
  readonly status: "fresh";
  readonly reason: null;
}

/** The signal is too old, implausible, or could not be read at all (then lastOkAt and ageMs are null). */
export interface StaleResult {
  readonly name: string;
  readonly lastOkAt: string | null;
  readonly ageMs: number | null;
  readonly status: "stale";
  readonly reason: string;
}

export type ProbeResult = FreshResult | StaleResult;

/**
 * Persisted per-check status. "unknown" means the check went stale but the alert could not be delivered,
 * so the next run must alert again while keeping the original `since`.
 */
export type CheckStatus = "fresh" | "stale" | "unknown";

export interface CheckState {
  readonly status: CheckStatus;
  /** ISO 8601: when the check entered its current status. */
  readonly since: string;
  /** ISO 8601: when the last stale or reminder alert went out; null if none is outstanding. */
  readonly notifiedAt: string | null;
}

/** Check name to state, as stored in the state file. */
export type StateMap = Readonly<Record<string, CheckState>>;

/** An alert to deliver. `since` is when the check went stale (ISO 8601). */
export type AlertEvent =
  | { readonly type: "stale"; readonly result: StaleResult; readonly since: string }
  | { readonly type: "reminder"; readonly result: StaleResult; readonly since: string }
  | { readonly type: "recovered"; readonly result: FreshResult; readonly since: string };

export type AlertType = AlertEvent["type"];

/** An alert that could not be delivered, or a failed heartbeat ping. */
export type DeliveryFailure = AlertEvent | { readonly type: "heartbeat" };

/** The slice of the global `fetch` staleguard uses; injectable for tests. */
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** I/O a probe performs; injectable for tests. */
export interface ProbeIo {
  readonly readFile: (path: string, encoding: "utf8") => Promise<string>;
  readonly stat: (path: string) => Promise<{ readonly mtime: Date }>;
  readonly fetch: Fetch;
}
