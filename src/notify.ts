// Alert text and delivery (Telegram, generic JSON webhook). Delivery functions throw on failure; the caller
// decides what to retry. URLs are never logged, because they may carry tokens.
import { formatAge } from "./duration.js";
import type { AlertEvent, AlertType, Fetch, TelegramConfig } from "./types.js";

const TITLE: Readonly<Record<AlertType, string>> = {
  stale: "STALE",
  reminder: "STILL STALE",
  recovered: "RECOVERED",
};

export interface AlertContext {
  readonly now: Date;
  readonly hostLabel?: string | null;
}

/** Body of a webhook POST. Field names are a public contract; see the README. */
export interface WebhookPayload {
  readonly event: AlertType;
  readonly check: string;
  readonly host: string | null;
  readonly reason: string | null;
  readonly lastOkAt: string | null;
  readonly ageSeconds: number | null;
  readonly since: string;
  readonly at: string;
  readonly text: string;
}

export function composeText(event: AlertEvent, { now, hostLabel = null }: AlertContext): string {
  const r = event.result;
  const where = hostLabel ? ` on ${hostLabel}` : "";
  const lines = [`${TITLE[event.type]}: ${r.name}${where}`];
  if (event.type === "recovered") {
    lines.push(`Fresh again; last success ${formatAge(event.result.ageMs)} ago.`);
    lines.push(`Was stale for ${formatAge(now.getTime() - Date.parse(event.since))}.`);
  } else {
    const { reason, lastOkAt, ageMs } = event.result;
    lines.push(`Reason: ${reason}`);
    lines.push(
      lastOkAt && ageMs !== null
        ? `Last success: ${lastOkAt} (${formatAge(ageMs)} ago)`
        : "Last success: unknown",
    );
    if (event.type === "reminder") lines.push(`Stale since ${event.since}.`);
  }
  return lines.join("\n");
}

export function webhookPayload(
  event: AlertEvent,
  { now, hostLabel = null }: AlertContext,
): WebhookPayload {
  const r = event.result;
  return {
    event: event.type,
    check: r.name,
    host: hostLabel,
    reason: r.reason,
    lastOkAt: r.lastOkAt,
    ageSeconds: r.ageMs === null ? null : Math.round(r.ageMs / 1000),
    since: event.since,
    at: now.toISOString(),
    text: composeText(event, { now, hostLabel }),
  };
}

export async function sendTelegram(
  { token, chatId }: TelegramConfig,
  text: string,
  fetchImpl: Fetch = fetch,
): Promise<void> {
  const res = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // Telegram rejects messages over 4096 characters; leave headroom.
    body: JSON.stringify({
      chat_id: chatId,
      text: text.slice(0, 3900),
      disable_web_page_preview: true,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Telegram responded ${res.status}`);
}

export async function sendWebhook(
  url: string,
  payload: WebhookPayload,
  fetchImpl: Fetch = fetch,
): Promise<void> {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    // A redirect could forward the alert body somewhere the operator never configured.
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`webhook responded ${res.status}`);
}
