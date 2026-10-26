// Alert text and delivery (Telegram, generic JSON webhook). Delivery functions throw on failure; the caller
// decides what to retry. URLs are never logged, because they may carry tokens.
import { formatAge } from "./duration.mjs";

const TITLE = { stale: "STALE", reminder: "STILL STALE", recovered: "RECOVERED" };

export function composeText(event, { now, hostLabel = null }) {
  const r = event.result;
  const where = hostLabel ? ` on ${hostLabel}` : "";
  const lines = [`${TITLE[event.type]}: ${r.name}${where}`];
  if (event.type === "recovered") {
    lines.push(`Fresh again; last success ${formatAge(r.ageMs)} ago.`);
    lines.push(`Was stale for ${formatAge(now - new Date(event.since))}.`);
  } else {
    lines.push(`Reason: ${r.reason}`);
    lines.push(r.lastOkAt ? `Last success: ${r.lastOkAt} (${formatAge(r.ageMs)} ago)` : "Last success: unknown");
    if (event.type === "reminder") lines.push(`Stale since ${event.since}.`);
  }
  return lines.join("\n");
}

export function webhookPayload(event, { now, hostLabel = null }) {
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

export async function sendTelegram({ token, chatId }, text, fetchImpl = fetch) {
  const res = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 3900), disable_web_page_preview: true }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Telegram responded ${res.status}`);
}

export async function sendWebhook(url, payload, fetchImpl = fetch) {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`webhook responded ${res.status}`);
}
